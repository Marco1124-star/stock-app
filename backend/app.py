from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
import re
import json
import urllib.request
import urllib.parse
import gzip
import os
import secrets
import sqlite3
from functools import wraps




app = Flask(__name__)
def _parse_cors_origins():
    raw = (os.environ.get("CORS_ORIGINS") or "").strip()
    if not raw:
        return None
    origins = [part.strip() for part in raw.split(",") if part.strip()]
    return origins or None


_cors_origins = _parse_cors_origins()
if _cors_origins:
    CORS(app, resources={r"/*": {"origins": _cors_origins}})
else:
    CORS(app)

AUTH_DB_PATH = (os.environ.get("AUTH_DB_PATH") or "").strip() or os.path.join(
    os.path.dirname(__file__), "stock_app.db"
)
AUTH_TOKEN_TTL = timedelta(days=30)


def _utc_now():
    return datetime.utcnow()


def _to_utc_iso(value):
    return value.replace(microsecond=0).isoformat() + "Z"


def _parse_utc_iso(value):
    if not value:
        return None
    try:
        normalized = str(value)
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except Exception:
        return None


def _get_db_connection():
    conn = sqlite3.connect(AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_auth_db():
    with _get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist_items (
                user_id INTEGER NOT NULL,
                ticker TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(user_id, ticker),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_portfolios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL,
                client_id TEXT NOT NULL,
                name TEXT NOT NULL,
                return_pct REAL NOT NULL DEFAULT 0,
                entries_count INTEGER NOT NULL DEFAULT 0,
                open_count INTEGER NOT NULL DEFAULT 0,
                closed_count INTEGER NOT NULL DEFAULT 0,
                tickers_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(owner_user_id, client_id),
                FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_portfolio_likes (
                portfolio_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(portfolio_id, user_id),
                FOREIGN KEY(portfolio_id) REFERENCES social_portfolios(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_portfolio_saves (
                portfolio_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(portfolio_id, user_id),
                FOREIGN KEY(portfolio_id) REFERENCES social_portfolios(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_portfolio_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                portfolio_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                ticker TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(portfolio_id) REFERENCES social_portfolios(id) ON DELETE CASCADE
            )
            """
        )


def _normalize_username(value):
    normalized = re.sub(r"\s+", "", (value or "").strip().lower())
    return normalized.lstrip("@")


def _is_valid_username(username):
    return bool(re.fullmatch(r"[a-z0-9_.-]{3,30}", username or ""))


def _is_valid_password(password):
    return isinstance(password, str) and len(password) >= 6


def _create_user_session(conn, user_id):
    now = _utc_now()
    token = secrets.token_urlsafe(32)
    conn.execute(
        """
        INSERT INTO sessions (token, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
        """,
        (token, int(user_id), _to_utc_iso(now), _to_utc_iso(now + AUTH_TOKEN_TTL)),
    )
    return token


def _extract_bearer_token():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header:
        return None
    prefix = "Bearer "
    if not auth_header.startswith(prefix):
        return None
    token = auth_header[len(prefix):].strip()
    return token or None


def _get_authenticated_user():
    token = _extract_bearer_token()
    if not token:
        return None, None

    with _get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT u.id, u.username, s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()

        if not row:
            return None, None

        expires_at = _parse_utc_iso(row["expires_at"])
        if expires_at is None or expires_at <= _utc_now():
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None, None

        user = {"id": int(row["id"]), "username": row["username"]}
        return user, token


def auth_required(view_fn):
    @wraps(view_fn)
    def wrapped(*args, **kwargs):
        user, token = _get_authenticated_user()
        if user is None:
            return jsonify({"error": "Non autorizzato"}), 401
        return view_fn(user, token, *args, **kwargs)

    return wrapped


def _normalize_watchlist_items(items):
    out = []
    seen = set()
    for item in items or []:
        ticker = str(item or "").strip().upper().replace(" ", "")
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        out.append(ticker)
    return out


def _get_watchlist_for_user(conn, user_id):
    rows = conn.execute(
        """
        SELECT ticker
        FROM watchlist_items
        WHERE user_id = ?
        ORDER BY position ASC
        """,
        (int(user_id),),
    ).fetchall()
    return [row["ticker"] for row in rows]


def _replace_watchlist_for_user(conn, user_id, tickers):
    user_id = int(user_id)
    now_iso = _to_utc_iso(_utc_now())
    conn.execute("DELETE FROM watchlist_items WHERE user_id = ?", (user_id,))
    for index, ticker in enumerate(tickers):
        conn.execute(
            """
            INSERT INTO watchlist_items (user_id, ticker, position, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, ticker, index, now_iso),
        )


def _coerce_non_negative_int(value, default=0):
    try:
        parsed = int(value)
        return parsed if parsed >= 0 else int(default)
    except Exception:
        return int(default)


def _coerce_float(value, default=0.0):
    try:
        parsed = float(value)
        if np.isfinite(parsed):
            return float(parsed)
    except Exception:
        pass
    return float(default)


def _normalize_social_tickers(items, limit=12):
    out = []
    seen = set()
    for item in items or []:
        ticker = str(item or "").strip().upper().replace(" ", "")
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        out.append(ticker)
        if len(out) >= limit:
            break
    return out


def _normalize_social_portfolios(items):
    if not isinstance(items, list):
        return []

    out = []
    seen_client_ids = set()
    for index, raw_item in enumerate(items):
        if not isinstance(raw_item, dict):
            continue

        client_id = str(raw_item.get("clientId") or raw_item.get("id") or "").strip()
        if not client_id:
            client_id = f"portfolio-{index + 1}"
        if client_id in seen_client_ids:
            continue
        seen_client_ids.add(client_id)

        name = str(raw_item.get("name") or "Portafoglio").strip() or "Portafoglio"
        name = name[:80]
        tickers = _normalize_social_tickers(raw_item.get("tickers") or [])
        entries_count = _coerce_non_negative_int(raw_item.get("entriesCount"), len(tickers))
        open_count = _coerce_non_negative_int(raw_item.get("openCount"), 0)
        closed_count = _coerce_non_negative_int(raw_item.get("closedCount"), 0)
        return_pct = round(_coerce_float(raw_item.get("returnPct"), 0.0), 4)

        out.append(
            {
                "clientId": client_id,
                "name": name,
                "returnPct": return_pct,
                "entriesCount": entries_count,
                "openCount": open_count,
                "closedCount": closed_count,
                "tickers": tickers,
            }
        )

    return out


def _replace_social_portfolios_for_user(conn, user_id, portfolios):
    user_id = int(user_id)
    now_iso = _to_utc_iso(_utc_now())
    client_ids = []

    for item in portfolios:
        client_id = item["clientId"]
        client_ids.append(client_id)
        existing_row = conn.execute(
            """
            SELECT id, tickers_json
            FROM social_portfolios
            WHERE owner_user_id = ? AND client_id = ?
            """,
            (user_id, client_id),
        ).fetchone()
        previous_tickers = _parse_tickers_json(existing_row["tickers_json"]) if existing_row else []
        conn.execute(
            """
            INSERT INTO social_portfolios (
                owner_user_id,
                client_id,
                name,
                return_pct,
                entries_count,
                open_count,
                closed_count,
                tickers_json,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, client_id) DO UPDATE SET
                name = excluded.name,
                return_pct = excluded.return_pct,
                entries_count = excluded.entries_count,
                open_count = excluded.open_count,
                closed_count = excluded.closed_count,
                tickers_json = excluded.tickers_json,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                client_id,
                item["name"],
                item["returnPct"],
                item["entriesCount"],
                item["openCount"],
                item["closedCount"],
                json.dumps(item["tickers"]),
                now_iso,
                now_iso,
            ),
        )
        if existing_row:
            _record_social_portfolio_events(
                conn,
                int(existing_row["id"]),
                previous_tickers,
                item["tickers"],
                now_iso,
            )

    if client_ids:
        placeholders = ",".join("?" for _ in client_ids)
        conn.execute(
            f"""
            DELETE FROM social_portfolios
            WHERE owner_user_id = ?
              AND client_id NOT IN ({placeholders})
            """,
            [user_id, *client_ids],
        )
    else:
        conn.execute("DELETE FROM social_portfolios WHERE owner_user_id = ?", (user_id,))


def _parse_tickers_json(raw_value):
    try:
        parsed = json.loads(raw_value or "[]")
    except Exception:
        parsed = []
    return _normalize_social_tickers(parsed)


def _record_social_portfolio_events(conn, portfolio_id, previous_tickers, current_tickers, now_iso):
    previous_list = _normalize_social_tickers(previous_tickers)
    current_list = _normalize_social_tickers(current_tickers)
    previous_set = set(previous_list)
    current_set = set(current_list)

    added = [ticker for ticker in current_list if ticker not in previous_set]
    removed = [ticker for ticker in previous_list if ticker not in current_set]

    if not added and not removed:
        return

    for ticker in added:
        conn.execute(
            """
            INSERT INTO social_portfolio_events (portfolio_id, action, ticker, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (int(portfolio_id), "buy", ticker, now_iso),
        )
    for ticker in removed:
        conn.execute(
            """
            INSERT INTO social_portfolio_events (portfolio_id, action, ticker, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (int(portfolio_id), "sell", ticker, now_iso),
        )

    conn.execute(
        """
        DELETE FROM social_portfolio_events
        WHERE portfolio_id = ?
          AND id NOT IN (
            SELECT id
            FROM social_portfolio_events
            WHERE portfolio_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 120
          )
        """,
        (int(portfolio_id), int(portfolio_id)),
    )


def _serialize_social_event_row(row):
    return {
        "id": int(row["id"]),
        "action": str(row["action"] or "").lower(),
        "ticker": str(row["ticker"] or "").upper(),
        "createdAt": row["created_at"],
    }


def _get_recent_social_events_by_portfolio(conn, portfolio_ids, limit_per_portfolio=6):
    normalized_ids = []
    for portfolio_id in portfolio_ids:
        try:
            parsed = int(portfolio_id)
            if parsed > 0:
                normalized_ids.append(parsed)
        except Exception:
            continue
    if not normalized_ids:
        return {}

    placeholders = ",".join("?" for _ in normalized_ids)
    rows = conn.execute(
        f"""
        SELECT id, portfolio_id, action, ticker, created_at
        FROM social_portfolio_events
        WHERE portfolio_id IN ({placeholders})
        ORDER BY created_at DESC, id DESC
        """,
        normalized_ids,
    ).fetchall()

    out = {portfolio_id: [] for portfolio_id in normalized_ids}
    for row in rows:
        portfolio_id = int(row["portfolio_id"])
        bucket = out.get(portfolio_id)
        if bucket is None:
            continue
        if len(bucket) >= int(limit_per_portfolio):
            continue
        bucket.append(_serialize_social_event_row(row))

    return out


def _serialize_social_portfolio_row(row):
    return {
        "id": int(row["id"]),
        "ownerUserId": int(row["owner_user_id"]),
        "ownerUsername": row["owner_username"],
        "clientId": row["client_id"],
        "name": row["name"],
        "returnPct": round(_coerce_float(row["return_pct"], 0.0), 2),
        "entriesCount": _coerce_non_negative_int(row["entries_count"], 0),
        "openCount": _coerce_non_negative_int(row["open_count"], 0),
        "closedCount": _coerce_non_negative_int(row["closed_count"], 0),
        "tickers": _parse_tickers_json(row["tickers_json"]),
        "updatedAt": row["updated_at"],
        "likesCount": _coerce_non_negative_int(row["likes_count"], 0),
        "savesCount": _coerce_non_negative_int(row["saves_count"], 0),
        "viewerLiked": bool(row["viewer_liked"]),
        "viewerSaved": bool(row["viewer_saved"]),
        "recentEvents": [],
    }


def _get_social_feed_for_user(conn, viewer_user_id):
    rows = conn.execute(
        """
        SELECT
            p.id,
            p.owner_user_id,
            u.username AS owner_username,
            p.client_id,
            p.name,
            p.return_pct,
            p.entries_count,
            p.open_count,
            p.closed_count,
            p.tickers_json,
            p.updated_at,
            COALESCE(l.likes_count, 0) AS likes_count,
            COALESCE(s.saves_count, 0) AS saves_count,
            CASE WHEN vl.user_id IS NULL THEN 0 ELSE 1 END AS viewer_liked,
            CASE WHEN vs.user_id IS NULL THEN 0 ELSE 1 END AS viewer_saved
        FROM social_portfolios p
        JOIN users u ON u.id = p.owner_user_id
        LEFT JOIN (
            SELECT portfolio_id, COUNT(*) AS likes_count
            FROM social_portfolio_likes
            GROUP BY portfolio_id
        ) l ON l.portfolio_id = p.id
        LEFT JOIN (
            SELECT portfolio_id, COUNT(*) AS saves_count
            FROM social_portfolio_saves
            GROUP BY portfolio_id
        ) s ON s.portfolio_id = p.id
        LEFT JOIN social_portfolio_likes vl
               ON vl.portfolio_id = p.id AND vl.user_id = ?
        LEFT JOIN social_portfolio_saves vs
               ON vs.portfolio_id = p.id AND vs.user_id = ?
        ORDER BY p.updated_at DESC, p.id DESC
        """,
        (int(viewer_user_id), int(viewer_user_id)),
    ).fetchall()
    items = [_serialize_social_portfolio_row(row) for row in rows]
    events_map = _get_recent_social_events_by_portfolio(
        conn, [item["id"] for item in items], limit_per_portfolio=6
    )
    for item in items:
        item["recentEvents"] = events_map.get(item["id"], [])
    return items


def _get_saved_social_portfolios_for_user(conn, user_id):
    rows = conn.execute(
        """
        SELECT
            p.id,
            p.owner_user_id,
            u.username AS owner_username,
            p.client_id,
            p.name,
            p.return_pct,
            p.entries_count,
            p.open_count,
            p.closed_count,
            p.tickers_json,
            p.updated_at,
            COALESCE(l.likes_count, 0) AS likes_count,
            COALESCE(s.saves_count, 0) AS saves_count,
            0 AS viewer_liked,
            1 AS viewer_saved
        FROM social_portfolios p
        JOIN users u ON u.id = p.owner_user_id
        JOIN social_portfolio_saves my_save
          ON my_save.portfolio_id = p.id AND my_save.user_id = ?
        LEFT JOIN (
            SELECT portfolio_id, COUNT(*) AS likes_count
            FROM social_portfolio_likes
            GROUP BY portfolio_id
        ) l ON l.portfolio_id = p.id
        LEFT JOIN (
            SELECT portfolio_id, COUNT(*) AS saves_count
            FROM social_portfolio_saves
            GROUP BY portfolio_id
        ) s ON s.portfolio_id = p.id
        ORDER BY my_save.created_at DESC, p.id DESC
        """,
        (int(user_id),),
    ).fetchall()
    items = [_serialize_social_portfolio_row(row) for row in rows]
    events_map = _get_recent_social_events_by_portfolio(
        conn, [item["id"] for item in items], limit_per_portfolio=8
    )
    for item in items:
        item["recentEvents"] = events_map.get(item["id"], [])
    return items


def _set_social_reaction(conn, table_name, user_id, portfolio_id, desired_state):
    user_id = int(user_id)
    portfolio_id = int(portfolio_id)
    row = conn.execute(
        f"SELECT 1 FROM {table_name} WHERE portfolio_id = ? AND user_id = ?",
        (portfolio_id, user_id),
    ).fetchone()
    currently_active = row is not None

    if desired_state is None:
        desired_state = not currently_active
    else:
        desired_state = bool(desired_state)

    if desired_state and not currently_active:
        conn.execute(
            f"""
            INSERT OR IGNORE INTO {table_name} (portfolio_id, user_id, created_at)
            VALUES (?, ?, ?)
            """,
            (portfolio_id, user_id, _to_utc_iso(_utc_now())),
        )
    elif not desired_state and currently_active:
        conn.execute(
            f"DELETE FROM {table_name} WHERE portfolio_id = ? AND user_id = ?",
            (portfolio_id, user_id),
        )

    return desired_state


def _get_social_reaction_snapshot(conn, portfolio_id, viewer_user_id):
    row = conn.execute(
        """
        SELECT
            COALESCE((SELECT COUNT(*) FROM social_portfolio_likes WHERE portfolio_id = ?), 0) AS likes_count,
            COALESCE((SELECT COUNT(*) FROM social_portfolio_saves WHERE portfolio_id = ?), 0) AS saves_count,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM social_portfolio_likes
                    WHERE portfolio_id = ? AND user_id = ?
                ) THEN 1
                ELSE 0
            END AS viewer_liked,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM social_portfolio_saves
                    WHERE portfolio_id = ? AND user_id = ?
                ) THEN 1
                ELSE 0
            END AS viewer_saved
        """,
        (
            int(portfolio_id),
            int(portfolio_id),
            int(portfolio_id),
            int(viewer_user_id),
            int(portfolio_id),
            int(viewer_user_id),
        ),
    ).fetchone()
    return {
        "likesCount": _coerce_non_negative_int(row["likes_count"], 0),
        "savesCount": _coerce_non_negative_int(row["saves_count"], 0),
        "viewerLiked": bool(row["viewer_liked"]),
        "viewerSaved": bool(row["viewer_saved"]),
    }


_init_auth_db()

# Cache rapido per endpoint /stock
stock_response_cache = {}
STOCK_CACHE_TTL = timedelta(seconds=120)
PRICE_ONLY_CACHE_TTL = timedelta(seconds=10)

# Cache endpoint pesanti
technicals_cache = {}
partial_corr_cache = {}
seasonality_cache = {}
history_cache = {}
supply_demand_cache = {}

TECHNICALS_CACHE_TTL = timedelta(minutes=4)
PARTIAL_CORR_CACHE_TTL = timedelta(minutes=12)
SEASONALITY_CACHE_TTL = timedelta(minutes=20)
HISTORY_CACHE_TTL = timedelta(seconds=120)
SUPPLY_DEMAND_CACHE_TTL = timedelta(minutes=6)

def _cache_get(cache_dict, key, ttl):
    entry = cache_dict.get(key)
    if not entry:
        return None
    payload, ts = entry
    if datetime.utcnow() - ts < ttl:
        return payload
    try:
        del cache_dict[key]
    except Exception:
        pass
    return None

def _cache_set(cache_dict, key, payload, max_size=300):
    cache_dict[key] = (payload, datetime.utcnow())
    # Bound memory: rimuove la chiave più vecchia quando supera soglia
    if len(cache_dict) > max_size:
        try:
            oldest_key = min(cache_dict, key=lambda k: cache_dict[k][1])
            del cache_dict[oldest_key]
        except Exception:
            pass

TF_MAPPING = {
    "1h": "60m",
    "4h": "240m",
    "1d": "1d",
    "1w": "1wk",
    "1mo": "1mo"
}

def normalize_ticker(value):
    if not value:
        return value
    t = value.strip().upper().replace(" ", "")
    if re.match(r"^\d+[A-Z]{1,6}(\.[A-Z]{1,3})?$", t):
        t = re.sub(r"^\d+", "", t)
    return t

def ticker_candidates(raw):
    raw_up = (raw or "").strip().upper().replace(" ", "")
    norm = normalize_ticker(raw_up)
    candidates = []
    # Se ticker senza suffisso ma inizia con cifra, prova Milano come fallback
    if raw_up and "." not in raw_up and re.match(r"^\d+[A-Z]{1,6}$", raw_up):
        candidates.append(f"{raw_up}.MI")
    for t in (raw_up, norm):
        if t and t not in candidates:
            candidates.append(t)
    return candidates

def fundamentals_candidates(raw):
    raw_up = (raw or "").strip().upper().replace(" ", "")
    norm = normalize_ticker(raw_up)
    candidates = []

    def add(v):
        if v and v not in candidates:
            candidates.append(v)

    add(raw_up)
    add(norm)

    # variante senza suffisso exchange (es: INTC.MI -> INTC)
    if norm and "." in norm:
        add(norm.split(".")[0])

    # se il ticker parte con cifra, prova anche base puro senza cifra/suffisso
    no_digits = re.sub(r"^\d+", "", raw_up) if raw_up else raw_up
    add(no_digits)
    if no_digits and "." in no_digits:
        add(no_digits.split(".")[0])

    return candidates

def safe_history(stock, *args, **kwargs):
    try:
        return stock.history(*args, **kwargs)
    except Exception:
        return pd.DataFrame()

def safe_download(*args, **kwargs):
    try:
        return yf.download(*args, **kwargs)
    except Exception:
        return pd.DataFrame()

def _resample_ohlc(df, rule):
    agg = {
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum",
    }
    out = df.resample(rule).agg(agg)
    return out.dropna(subset=["Close"])

def _normalize_ohlc_df(df):
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return pd.DataFrame()
    out = df.copy()
    if isinstance(out.columns, pd.MultiIndex):
        # yfinance.download può restituire MultiIndex anche per un solo ticker
        try:
            out.columns = out.columns.get_level_values(0)
        except Exception:
            pass
    if isinstance(out.index, pd.DatetimeIndex):
        try:
            # Mantieni la data/ora "locale" della borsa: non convertire in UTC,
            # altrimenti mese/giorno possono slittare.
            out.index = out.index.tz_localize(None)
        except Exception:
            try:
                out.index = out.index.tz_localize(None)
            except Exception:
                pass
    return out.sort_index()

def _fetch_interval_history(cand, stock, period, interval, chart_range):
    hist = _normalize_ohlc_df(safe_history(stock, period=period, interval=interval))
    if hist.empty:
        hist = _normalize_ohlc_df(
            safe_download(cand, period=period, interval=interval, progress=False, threads=False)
        )

    # Per weekly/monthly preferisci ricostruzione da daily: è più stabile e precisa
    # quando Yahoo limita il numero di punti per interval=1wk/1mo.
    if hist.empty and interval in ("1wk", "1mo"):
        daily = _normalize_ohlc_df(safe_history(stock, period=period, interval="1d"))
        if daily.empty:
            daily = _normalize_ohlc_df(
                safe_download(cand, period=period, interval="1d", progress=False, threads=False)
            )
        if daily.empty:
            daily, _ = _fetch_chart_data(cand, chart_range, "1d")
            daily = _normalize_ohlc_df(daily)
        if not daily.empty:
            rule = "W-FRI" if interval == "1wk" else "ME"
            hist = _resample_ohlc(daily, rule)

    if hist.empty:
        hist, _ = _fetch_chart_data(cand, chart_range, interval)
        hist = _normalize_ohlc_df(hist)

    return hist

def _fetch_chart_data(ticker, range_str="5d", interval="1d"):
    try:
        encoded = urllib.parse.quote(ticker)
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
            f"?range={range_str}&interval={interval}&includePrePost=false&events=div,splits"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return pd.DataFrame(), {}
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return pd.DataFrame(), {}

    result = payload.get("chart", {}).get("result")
    if not result:
        return pd.DataFrame(), {}
    r0 = result[0]
    timestamps = r0.get("timestamp") or []
    quotes = r0.get("indicators", {}).get("quote", [])
    if not timestamps or not quotes:
        return pd.DataFrame(), r0.get("meta", {}) or {}

    q0 = quotes[0]
    df = pd.DataFrame(
        {
            "Open": q0.get("open"),
            "High": q0.get("high"),
            "Low": q0.get("low"),
            "Close": q0.get("close"),
            "Volume": q0.get("volume"),
        },
        index=pd.to_datetime(timestamps, unit="s"),
    )
    df = df.dropna(subset=["Close"])
    return df, r0.get("meta", {}) or {}

def _fetch_quote_fields(ticker):
    try:
        encoded = urllib.parse.quote(ticker)
        url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={encoded}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return {}
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}

    results = payload.get("quoteResponse", {}).get("result") or []
    if not results:
        return {}
    q0 = results[0]
    return {
        "marketCap": q0.get("marketCap"),
        "trailingPE": q0.get("trailingPE"),
        "forwardPE": q0.get("forwardPE"),
        "trailingEps": q0.get("epsTrailingTwelveMonths"),
        "epsForward": q0.get("epsForward"),
        "sharesOutstanding": q0.get("sharesOutstanding"),
        "dividendRate": q0.get("dividendRate"),
        "dividendYield": q0.get("dividendYield"),
        "beta": q0.get("beta"),
        "priceToBook": q0.get("priceToBook"),
        "priceToSalesTrailing12Months": q0.get("priceToSalesTrailing12Months"),
        "bookValue": q0.get("bookValue"),
        "totalRevenue": q0.get("totalRevenue"),
        "trailingAnnualDividendRate": q0.get("trailingAnnualDividendRate"),
        "trailingAnnualDividendYield": q0.get("trailingAnnualDividendYield"),
        "shortName": q0.get("shortName") or q0.get("longName"),
        "sector": q0.get("sector") or q0.get("industry")
    }

def _fetch_quote_summary_fields(ticker):
    try:
        encoded = urllib.parse.quote(ticker)
        url = (
            f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{encoded}"
            f"?modules=summaryDetail,defaultKeyStatistics,financialData"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return {}
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}

    result = payload.get("quoteSummary", {}).get("result") or []
    if not result:
        return {}
    r0 = result[0]
    summary = r0.get("summaryDetail") or {}
    stats = r0.get("defaultKeyStatistics") or {}
    financial = r0.get("financialData") or {}

    def raw(obj, key):
        val = obj.get(key)
        if isinstance(val, dict):
            return val.get("raw")
        return val

    return {
        "marketCap": raw(summary, "marketCap") or raw(stats, "marketCap"),
        "trailingPE": raw(summary, "trailingPE"),
        "forwardPE": raw(summary, "forwardPE") or raw(financial, "forwardPE"),
        "trailingEps": raw(stats, "trailingEps"),
        "epsForward": raw(stats, "forwardEps") or raw(financial, "forwardEps"),
        "sharesOutstanding": raw(stats, "sharesOutstanding"),
        "dividendRate": raw(summary, "dividendRate") or raw(summary, "trailingAnnualDividendRate"),
        "dividendYield": raw(summary, "dividendYield") or raw(summary, "trailingAnnualDividendYield"),
        "beta": raw(summary, "beta") or raw(stats, "beta"),
        "priceToSalesTrailing12Months": raw(summary, "priceToSalesTrailing12Months"),
        "priceToBook": raw(stats, "priceToBook"),
        "bookValue": raw(stats, "bookValue"),
        "totalRevenue": raw(financial, "totalRevenue"),
        "netIncomeToCommon": raw(financial, "netIncomeToCommon") or raw(financial, "netIncome")
    }

def _to_float(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float, np.integer, np.floating)):
            v = float(value)
            return v if np.isfinite(v) else None
        if isinstance(value, dict):
            if "raw" in value:
                return _to_float(value.get("raw"))
            if "fmt" in value:
                return _to_float(value.get("fmt"))
            return None
        if isinstance(value, str):
            s = value.strip().replace(",", "")
            if not s or s.upper() in {"N/A", "ND", "N/D", "-", "--", "—"}:
                return None
            if s.endswith("%"):
                base = _to_float(s[:-1])
                return (base / 100.0) if base is not None else None
            mult = 1.0
            suffix = s[-1].upper()
            if suffix in {"K", "M", "B", "T"}:
                mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[suffix]
                s = s[:-1]
            v = float(s) * mult
            return v if np.isfinite(v) else None
    except Exception:
        return None
    return None

def _to_text(value):
    if value is None:
        return None
    if isinstance(value, dict):
        if "fmt" in value and value.get("fmt"):
            return str(value.get("fmt")).strip()
        if "raw" in value and value.get("raw") is not None:
            return str(value.get("raw")).strip()
        return None
    if isinstance(value, str):
        txt = value.strip()
        return txt or None
    return str(value).strip() or None

def _merge_missing_info(target, source):
    if not isinstance(source, dict):
        return
    text_keys = {"shortName", "sector"}
    for k, v in source.items():
        if target.get(k) is not None or v is None:
            continue
        if k in text_keys:
            txt = _to_text(v)
            if txt is not None:
                target[k] = txt
            continue
        num = _to_float(v)
        if num is not None:
            target[k] = num

def _normalize_info_payload(raw_info):
    if not isinstance(raw_info, dict):
        return {}

    def pick(*keys):
        for key in keys:
            if raw_info.get(key) is not None:
                return raw_info.get(key)
        return None

    normalized = {
        "marketCap": pick("marketCap", "market_cap"),
        "trailingPE": pick("trailingPE", "trailingPe"),
        "forwardPE": pick("forwardPE", "forwardPe"),
        "trailingEps": pick("trailingEps", "epsTrailingTwelveMonths", "eps"),
        "epsForward": pick("forwardEps", "epsForward", "epsNext5Y"),
        "sharesOutstanding": pick("sharesOutstanding", "shareOutstanding", "shares"),
        "dividendRate": pick("dividendRate", "trailingAnnualDividendRate"),
        "dividendYield": pick("dividendYield", "trailingAnnualDividendYield"),
        "beta": pick("beta", "beta3Year"),
        "priceToBook": pick("priceToBook"),
        "priceToSalesTrailing12Months": pick("priceToSalesTrailing12Months", "priceToSales"),
        "bookValue": pick("bookValue"),
        "totalRevenue": pick("totalRevenue", "revenue"),
        "netIncomeToCommon": pick("netIncomeToCommon", "netIncome"),
        "averageVolume": pick(
            "averageVolume",
            "averageVolume10days",
            "averageDailyVolume10Day",
            "averageDailyVolume3Month",
            "threeMonthAverageVolume",
            "tenDayAverageVolume",
        ),
        "volume": pick("volume", "regularMarketVolume"),
        "fiftyTwoWeekLow": pick("fiftyTwoWeekLow", "yearLow"),
        "fiftyTwoWeekHigh": pick("fiftyTwoWeekHigh", "yearHigh"),
        "earningsGrowth": pick("earningsGrowth", "earningsQuarterlyGrowth"),
        "shortName": pick("shortName", "longName"),
        "sector": pick("sector", "industry", "category"),
    }
    return normalized

def _safe_get_info(stock):
    if stock is None:
        return {}
    try:
        fn = getattr(stock, "get_info", None)
        if callable(fn):
            data = fn()
            if isinstance(data, dict) and data:
                return data
    except Exception:
        pass
    try:
        data = stock.info
        if isinstance(data, dict) and data:
            return data
    except Exception:
        pass
    return {}

def _extract_fast_info_fields(stock):
    out = {}
    try:
        fi = getattr(stock, "fast_info", None)
        if fi is None:
            return out

        def fi_get(key):
            if isinstance(fi, dict):
                return fi.get(key)
            return getattr(fi, key, None)

        def fi_pick(*keys):
            for key in keys:
                val = fi_get(key)
                if val is not None:
                    return val
            return None

        out = {
            "marketCap": fi_pick("marketCap", "market_cap"),
            "sharesOutstanding": fi_pick("sharesOutstanding", "shares"),
            "fiftyTwoWeekLow": fi_pick("yearLow", "year_low"),
            "fiftyTwoWeekHigh": fi_pick("yearHigh", "year_high"),
            "volume": fi_pick("lastVolume", "volume", "regularMarketVolume"),
            "tenDayAverageVolume": fi_pick("tenDayAverageVolume", "ten_day_average_volume"),
            "threeMonthAverageVolume": fi_pick("threeMonthAverageVolume", "three_month_average_volume"),
            "lastPrice": fi_pick("lastPrice", "last_price", "regularMarketPrice", "regular_market_price"),
        }
    except Exception:
        return {}
    return {k: v for k, v in out.items() if v is not None}

def _extract_json_numeric(html, key):
    pattern = rf'\\"{re.escape(key)}\\":\{{\\"raw\\":(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)'
    m = re.search(pattern, html)
    if not m:
        return None
    return _to_float(m.group(1))

def _extract_streamer_numeric(html, key):
    patterns = [
        rf'<fin-streamer[^>]*data-field="{re.escape(key)}"[^>]*data-value="([^"]+)"',
        rf'<fin-streamer[^>]*data-value="([^"]+)"[^>]*data-field="{re.escape(key)}"',
    ]
    for pattern in patterns:
        m = re.search(pattern, html)
        if m:
            return _to_float(m.group(1))
    return None

def _fetch_quote_page_fields(ticker):
    symbol = (ticker or "").strip().upper()
    if not symbol:
        return {}

    encoded = urllib.parse.quote(symbol, safe="")
    urls = []
    for u in (
        f"https://finance.yahoo.com/quote/{symbol}/?p={symbol}",
        f"https://finance.yahoo.com/quote/{encoded}/?p={encoded}",
    ):
        if u not in urls:
            urls.append(u)

    html = ""
    for url in urls:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept-Encoding": "gzip",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                encoding = (resp.headers.get("Content-Encoding") or "").lower()
                if encoding == "gzip" or body[:2] == b"\x1f\x8b":
                    try:
                        body = gzip.decompress(body)
                    except Exception:
                        pass
                html = body.decode("utf-8", errors="ignore")
            if html:
                break
        except Exception:
            continue

    if not html:
        return {}

    key_map = {
        "marketCap": "marketCap",
        "trailingPE": "trailingPE",
        "forwardPE": "forwardPE",
        "trailingEps": "trailingEps",
        "forwardEps": "epsForward",
        "sharesOutstanding": "sharesOutstanding",
        "dividendRate": "dividendRate",
        "dividendYield": "dividendYield",
        "beta": "beta",
        "priceToBook": "priceToBook",
        "priceToSalesTrailing12Months": "priceToSalesTrailing12Months",
        "bookValue": "bookValue",
        "totalRevenue": "totalRevenue",
        "netIncomeToCommon": "netIncomeToCommon",
        "earningsGrowth": "earningsGrowth",
    }

    out = {}
    for raw_key, out_key in key_map.items():
        val = _extract_json_numeric(html, raw_key)
        if val is None:
            val = _extract_streamer_numeric(html, raw_key)
        if val is not None:
            out[out_key] = val

    for text_key, out_key in (("shortName", "shortName"), ("longName", "shortName"), ("sector", "sector")):
        if out.get(out_key):
            continue
        m = re.search(rf'\\"{re.escape(text_key)}\\":\\"([^\\"]+)\\"', html)
        if m:
            try:
                txt = bytes(m.group(1), "utf-8").decode("unicode_escape")
            except Exception:
                txt = m.group(1)
            txt = _to_text(txt)
            if txt:
                out[out_key] = txt

    return out

def _first_from_stocks(stocks, getter):
    for _, stk in stocks:
        try:
            val = getter(stk)
        except Exception:
            val = None
        if val is not None:
            return val
    return None

def _latest_numeric(obj):
    if obj is None:
        return None
    try:
        if isinstance(obj, pd.Series):
            s = pd.to_numeric(obj, errors="coerce").dropna()
            return float(s.iloc[-1]) if not s.empty else None
        if isinstance(obj, pd.DataFrame):
            df = obj.select_dtypes(include=[np.number])
            if df.empty:
                df = obj.apply(pd.to_numeric, errors="coerce")
            if df.empty:
                return None
            row = df.iloc[-1].dropna()
            return float(row.iloc[-1]) if not row.empty else None
    except Exception:
        return None
    return None

def _get_shares_outstanding(stock):
    try:
        if hasattr(stock, "get_shares_full"):
            sh = stock.get_shares_full()
            val = _latest_numeric(sh)
            if val:
                return val
    except Exception:
        pass
    return None

def _get_net_income(stock):
    try:
        fin = None
        if hasattr(stock, "get_income_stmt"):
            fin = stock.get_income_stmt()
        if fin is None or not isinstance(fin, pd.DataFrame) or fin.empty:
            fin = stock.financials
        if fin is None or not isinstance(fin, pd.DataFrame) or fin.empty:
            return None
        # cerca righe con net income
        for idx in fin.index:
            if isinstance(idx, str) and "net income" in idx.lower():
                series = fin.loc[idx]
                series = pd.to_numeric(series, errors="coerce").dropna()
                if not series.empty:
                    return float(series.iloc[0])
    except Exception:
        return None
    return None

def _normalize_row_key(name):
    if not isinstance(name, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", name.lower())

def _extract_statement_value(df, key_candidates):
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return None
    norm_candidates = {_normalize_row_key(k) for k in key_candidates}
    for idx in df.index:
        nk = _normalize_row_key(idx)
        if nk in norm_candidates:
            series = pd.to_numeric(df.loc[idx], errors="coerce").dropna()
            if not series.empty:
                return float(series.iloc[0])
    return None

def _get_total_revenue(stock):
    try:
        dfs = []
        if hasattr(stock, "get_income_stmt"):
            dfs.append(stock.get_income_stmt())
        dfs.append(getattr(stock, "financials", None))
        for df in dfs:
            val = _extract_statement_value(df, [
                "Total Revenue",
                "Revenue",
                "Operating Revenue",
            ])
            if val is not None:
                return val
    except Exception:
        return None
    return None

def _get_total_equity(stock):
    try:
        dfs = []
        if hasattr(stock, "get_balance_sheet"):
            dfs.append(stock.get_balance_sheet())
        dfs.append(getattr(stock, "balance_sheet", None))
        for df in dfs:
            val = _extract_statement_value(df, [
                "Total Stockholder Equity",
                "Stockholders Equity",
                "Total Equity Gross Minority Interest",
                "Common Stock Equity",
            ])
            if val is not None:
                return val
    except Exception:
        return None
    return None


@app.route("/auth/register", methods=["POST"])
def register_user():
    payload = request.get_json(silent=True) or {}
    username = _normalize_username(payload.get("username"))
    password = payload.get("password") or ""

    if not _is_valid_username(username):
        return jsonify({"error": "Username non valido. Usa 3-30 caratteri (a-z, 0-9, _, -, .)"}), 400
    if not _is_valid_password(password):
        return jsonify({"error": "Password troppo corta (minimo 6 caratteri)"}), 400

    try:
        with _get_db_connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users (username, password_hash, created_at)
                VALUES (?, ?, ?)
                """,
                (username, generate_password_hash(password), _to_utc_iso(_utc_now())),
            )
            user_id = int(cursor.lastrowid)
            token = _create_user_session(conn, user_id)
    except sqlite3.IntegrityError:
        return jsonify({"error": "Username gia in uso"}), 409

    return jsonify({"token": token, "user": {"id": user_id, "username": username}}), 201


@app.route("/auth/login", methods=["POST"])
def login_user():
    payload = request.get_json(silent=True) or {}
    username = _normalize_username(payload.get("username"))
    password = payload.get("password") or ""

    if not username or not password:
        return jsonify({"error": "Inserisci username e password"}), 400

    with _get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT id, username, password_hash
            FROM users
            WHERE username = ?
            """,
            (username,),
        ).fetchone()

        if not row or not check_password_hash(row["password_hash"], password):
            return jsonify({"error": "Credenziali non valide"}), 401

        token = _create_user_session(conn, int(row["id"]))
        user = {"id": int(row["id"]), "username": row["username"]}

    return jsonify({"token": token, "user": user})


@app.route("/auth/me")
@auth_required
def get_current_user(user, _token):
    return jsonify({"user": user})


@app.route("/auth/logout", methods=["POST"])
@auth_required
def logout_user(_user, token):
    with _get_db_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return jsonify({"ok": True})


@app.route("/auth/username", methods=["PATCH", "PUT"])
@auth_required
def update_username(user, _token):
    payload = request.get_json(silent=True) or {}
    username = _normalize_username(payload.get("username"))

    if not _is_valid_username(username):
        return jsonify({"error": "Username non valido. Usa 3-30 caratteri (a-z, 0-9, _, -, .)"}), 400
    if username == user["username"]:
        return jsonify({"user": user, "ok": True})

    try:
        with _get_db_connection() as conn:
            conn.execute(
                """
                UPDATE users
                SET username = ?
                WHERE id = ?
                """,
                (username, int(user["id"])),
            )
    except sqlite3.IntegrityError:
        return jsonify({"error": "Username gia in uso"}), 409

    return jsonify({"ok": True, "user": {"id": int(user["id"]), "username": username}})


@app.route("/auth/password", methods=["PUT"])
@auth_required
def update_password(user, _token):
    payload = request.get_json(silent=True) or {}
    current_password = payload.get("currentPassword") or ""
    new_password = payload.get("newPassword") or ""

    if not current_password:
        return jsonify({"error": "Inserisci la password attuale"}), 400
    if not _is_valid_password(new_password):
        return jsonify({"error": "Password troppo corta (minimo 6 caratteri)"}), 400
    if current_password == new_password:
        return jsonify({"error": "La nuova password deve essere diversa da quella attuale"}), 400

    with _get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT password_hash
            FROM users
            WHERE id = ?
            """,
            (int(user["id"]),),
        ).fetchone()
        if not row or not check_password_hash(row["password_hash"], current_password):
            return jsonify({"error": "Password attuale non valida"}), 401

        conn.execute(
            """
            UPDATE users
            SET password_hash = ?
            WHERE id = ?
            """,
            (generate_password_hash(new_password), int(user["id"])),
        )

    return jsonify({"ok": True})


@app.route("/auth/me", methods=["DELETE"])
@auth_required
def delete_current_user(user, _token):
    payload = request.get_json(silent=True) or {}
    current_password = payload.get("currentPassword") or ""

    if not current_password:
        return jsonify({"error": "Inserisci la password per eliminare l'account"}), 400

    with _get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT password_hash
            FROM users
            WHERE id = ?
            """,
            (int(user["id"]),),
        ).fetchone()
        if not row or not check_password_hash(row["password_hash"], current_password):
            return jsonify({"error": "Password attuale non valida"}), 401

        conn.execute("DELETE FROM users WHERE id = ?", (int(user["id"]),))

    return jsonify({"ok": True})


@app.route("/watchlist")
@auth_required
def get_watchlist(user, _token):
    with _get_db_connection() as conn:
        watchlist = _get_watchlist_for_user(conn, user["id"])
    return jsonify({"watchlist": watchlist})


@app.route("/watchlist", methods=["PUT"])
@auth_required
def update_watchlist(user, _token):
    payload = request.get_json(silent=True) or {}
    incoming = payload.get("watchlist")
    if incoming is None:
        incoming = payload.get("tickers")
    if not isinstance(incoming, list):
        return jsonify({"error": "Payload non valido: watchlist deve essere una lista"}), 400

    watchlist = _normalize_watchlist_items(incoming)
    with _get_db_connection() as conn:
        _replace_watchlist_for_user(conn, user["id"], watchlist)
    return jsonify({"watchlist": watchlist})


@app.route("/social/portfolios", methods=["PUT"])
@auth_required
def update_social_portfolios(user, _token):
    payload = request.get_json(silent=True) or {}
    incoming = payload.get("portfolios")
    if not isinstance(incoming, list):
        return jsonify({"error": "Payload non valido: portfolios deve essere una lista"}), 400

    portfolios = _normalize_social_portfolios(incoming)
    with _get_db_connection() as conn:
        _replace_social_portfolios_for_user(conn, user["id"], portfolios)
    return jsonify({"portfolios": portfolios, "count": len(portfolios)})


@app.route("/social/feed")
@auth_required
def get_social_feed(user, _token):
    with _get_db_connection() as conn:
        feed = _get_social_feed_for_user(conn, user["id"])
    return jsonify({"feed": feed})


@app.route("/social/saved")
@auth_required
def get_saved_social_portfolios(user, _token):
    with _get_db_connection() as conn:
        saved = _get_saved_social_portfolios_for_user(conn, user["id"])
    return jsonify({"saved": saved})


@app.route("/social/portfolios/<int:portfolio_id>/like", methods=["POST"])
@auth_required
def toggle_social_like(user, _token, portfolio_id):
    payload = request.get_json(silent=True) or {}
    desired_like = payload.get("liked")

    with _get_db_connection() as conn:
        exists = conn.execute(
            "SELECT id FROM social_portfolios WHERE id = ?",
            (int(portfolio_id),),
        ).fetchone()
        if not exists:
            return jsonify({"error": "Portafoglio social non trovato"}), 404

        _set_social_reaction(
            conn,
            "social_portfolio_likes",
            user["id"],
            portfolio_id,
            desired_like,
        )
        snapshot = _get_social_reaction_snapshot(conn, portfolio_id, user["id"])

    return jsonify(
        {
            "portfolioId": int(portfolio_id),
            "liked": snapshot["viewerLiked"],
            "likesCount": snapshot["likesCount"],
            "savesCount": snapshot["savesCount"],
            "saved": snapshot["viewerSaved"],
        }
    )


@app.route("/social/portfolios/<int:portfolio_id>/save", methods=["POST"])
@auth_required
def toggle_social_save(user, _token, portfolio_id):
    payload = request.get_json(silent=True) or {}
    desired_save = payload.get("saved")

    with _get_db_connection() as conn:
        exists = conn.execute(
            "SELECT id FROM social_portfolios WHERE id = ?",
            (int(portfolio_id),),
        ).fetchone()
        if not exists:
            return jsonify({"error": "Portafoglio social non trovato"}), 404

        _set_social_reaction(
            conn,
            "social_portfolio_saves",
            user["id"],
            portfolio_id,
            desired_save,
        )
        snapshot = _get_social_reaction_snapshot(conn, portfolio_id, user["id"])

    return jsonify(
        {
            "portfolioId": int(portfolio_id),
            "saved": snapshot["viewerSaved"],
            "savesCount": snapshot["savesCount"],
            "likesCount": snapshot["likesCount"],
            "liked": snapshot["viewerLiked"],
        }
    )


@app.route("/stock/<ticker>")
def get_stock(ticker):
    raw_ticker = ticker
    tf = request.args.get("timeframe", "1d")
    price_only = request.args.get("priceOnly", "false").lower() == "true"
    yf_interval = TF_MAPPING.get(tf, "1d")
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"{cache_symbol}:{yf_interval}:priceOnly={price_only}"
    cache_entry = stock_response_cache.get(cache_key)
    if cache_entry:
        payload, ts = cache_entry
        ttl = PRICE_ONLY_CACHE_TTL if price_only else STOCK_CACHE_TTL
        if datetime.utcnow() - ts < ttl:
            return jsonify(payload)

    try:
        stock = None
        info = {}
        daily_data = pd.DataFrame()
        chart_meta = {}
        candidates = ticker_candidates(raw_ticker)

        # Prezzi giornalieri (fallback su periodi piu' lunghi)
        for cand in candidates:
            stock = yf.Ticker(cand)
            chart_meta = {}
            daily_data = safe_history(stock, period="2d", interval="1d")
            if daily_data.empty:
                daily_data = safe_history(stock, period="5d", interval="1d")
            if daily_data.empty:
                daily_data = safe_history(stock, period="1mo", interval="1d")
            if daily_data.empty:
                daily_data = safe_download(
                    cand, period="1mo", interval="1d",
                    progress=False, threads=False
                )
            if daily_data.empty:
                daily_data, chart_meta = _fetch_chart_data(cand, "5d", "1d")
            if not daily_data.empty:
                ticker = cand
                break

        if daily_data.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        # Evita stock.info come prima fonte: spesso lento/instabile
        info = {}

        # Normalize columns to avoid None/NaN errors
        for col in ("Open", "High", "Low", "Close"):
            if col not in daily_data.columns:
                daily_data[col] = np.nan
        daily_data["Close"] = pd.to_numeric(daily_data["Close"], errors="coerce")
        daily_data["Low"] = pd.to_numeric(daily_data["Low"], errors="coerce").fillna(daily_data["Close"])
        daily_data["High"] = pd.to_numeric(daily_data["High"], errors="coerce").fillna(daily_data["Close"])
        daily_data = daily_data.dropna(subset=["Close"])
        if daily_data.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        current_price = float(daily_data["Close"].iloc[-1])
        daily_low = float(daily_data["Low"].iloc[-1])
        daily_high = float(daily_data["High"].iloc[-1])
        prev_close = float(daily_data["Close"].iloc[-2]) if len(daily_data) >= 2 else None
        daily_change = round(((current_price - prev_close) / prev_close) * 100, 2) if prev_close else None

        if price_only:
            payload = {
                "info": {
                    "currentPrice": current_price,
                    "dailyChange": daily_change,
                    "dailyLow": daily_low,
                    "dailyHigh": daily_high
                }
            }
            stock_response_cache[cache_key] = (payload, datetime.utcnow())
            return jsonify(payload)

        # OHLC storici (periodi mirati + fallback robusto per 1W/1M)
        if yf_interval.endswith("m") and yf_interval not in ("1mo",):
            period = "60d"
            chart_range = "60d"
        elif yf_interval == "1d":
            period = "6y"
            chart_range = "10y"
        elif yf_interval == "1wk":
            period = "10y"
            chart_range = "10y"
        elif yf_interval == "1mo":
            period = "20y"
            chart_range = "20y"
        else:
            period = "5y"
            chart_range = "10y"

        hist = _fetch_interval_history(ticker, stock, period, yf_interval, chart_range)
        if hist.empty:
            # Fallback finale: usa daily_data per evitare 404 in frontend
            hist = daily_data.copy()
            if yf_interval == "1wk":
                hist = _resample_ohlc(hist, "W-FRI")
            elif yf_interval == "1mo":
                hist = _resample_ohlc(hist, "ME")
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        if chart_meta:
            if not info.get("shortName"):
                info["shortName"] = chart_meta.get("shortName") or chart_meta.get("symbol")
            if info.get("marketCap") is None and chart_meta.get("marketCap") is not None:
                info["marketCap"] = chart_meta.get("marketCap")
            if info.get("fiftyTwoWeekLow") is None and chart_meta.get("fiftyTwoWeekLow") is not None:
                info["fiftyTwoWeekLow"] = chart_meta.get("fiftyTwoWeekLow")
            if info.get("fiftyTwoWeekHigh") is None and chart_meta.get("fiftyTwoWeekHigh") is not None:
                info["fiftyTwoWeekHigh"] = chart_meta.get("fiftyTwoWeekHigh")
            if info.get("volume") is None and chart_meta.get("regularMarketVolume") is not None:
                info["volume"] = chart_meta.get("regularMarketVolume")

        # Candidati fondamentali: prima ticker richiesto, poi varianti normalizzate
        fund_symbols = []
        for source in (raw_ticker, ticker):
            for cand in fundamentals_candidates(source):
                if cand and cand not in fund_symbols:
                    fund_symbols.append(cand)

        fund_stocks = []
        for sym in fund_symbols:
            if sym == ticker and stock is not None:
                fund_stocks.append((sym, stock))
                continue
            try:
                fund_stocks.append((sym, yf.Ticker(sym)))
            except Exception:
                continue
        if not fund_stocks and stock is not None:
            fund_stocks = [(ticker, stock)]

        core_missing_keys = [
            "marketCap", "trailingPE", "forwardPE",
            "trailingEps", "epsForward",
            "dividendRate", "dividendYield", "beta",
            "priceToBook", "priceToSalesTrailing12Months",
            "sharesOutstanding", "totalRevenue",
        ]
        optional_missing_keys = [
            "bookValue", "netIncomeToCommon",
            "averageVolume", "volume",
            "fiftyTwoWeekLow", "fiftyTwoWeekHigh",
            "shortName", "sector"
        ]

        def has_missing(keys):
            return any(info.get(k) is None for k in keys)

        if has_missing(core_missing_keys + optional_missing_keys):
            for sym, cand_stock in fund_stocks:
                _merge_missing_info(info, _fetch_quote_fields(sym))
                _merge_missing_info(info, _fetch_quote_summary_fields(sym))
                _merge_missing_info(info, _fetch_quote_page_fields(sym))

                # stock.info e' spesso lento/rate-limited: usalo solo se mancano metriche core
                if has_missing(core_missing_keys):
                    _merge_missing_info(info, _normalize_info_payload(_safe_get_info(cand_stock)))

                if not has_missing(core_missing_keys + optional_missing_keys):
                    break

        # Fast info da tutti i candidati (fonte robusta anche con rate-limit)
        fast_info = {}
        for _, cand_stock in fund_stocks:
            _merge_missing_info(fast_info, _extract_fast_info_fields(cand_stock))

        def pick(*vals):
            for v in vals:
                if v is not None and v == v:
                    return v
            return None

        last_volume = None
        if "Volume" in daily_data.columns and not daily_data.empty:
            try:
                last_volume = float(daily_data["Volume"].iloc[-1])
            except Exception:
                last_volume = None

        avg_volume_calc = None
        if "Volume" in hist.columns and not hist.empty:
            try:
                avg_volume_calc = float(hist["Volume"].tail(30).mean())
            except Exception:
                avg_volume_calc = None
        elif "Volume" in daily_data.columns and not daily_data.empty:
            try:
                avg_volume_calc = float(daily_data["Volume"].tail(30).mean())
            except Exception:
                avg_volume_calc = None

        year_hist = safe_history(stock, period="1y", interval="1d")
        if (year_hist is None) or year_hist.empty:
            year_hist = hist if (not hist.empty and yf_interval == "1d") else pd.DataFrame()
        if year_hist.empty:
            year_hist = daily_data

        year_low = None
        year_high = None
        if "Low" in year_hist.columns and not year_hist.empty:
            try:
                year_low = float(year_hist["Low"].min())
            except Exception:
                year_low = None
        if "High" in year_hist.columns and not year_hist.empty:
            try:
                year_high = float(year_hist["High"].max())
            except Exception:
                year_high = None

        market_cap = pick(info.get("marketCap"), fast_info.get("marketCap"))
        shares_outstanding = pick(info.get("sharesOutstanding"), fast_info.get("sharesOutstanding"))
        if shares_outstanding is None:
            shares_outstanding = _first_from_stocks(fund_stocks, _get_shares_outstanding)
        if market_cap is None and shares_outstanding and current_price:
            try:
                market_cap = float(shares_outstanding) * float(current_price)
            except Exception:
                market_cap = None
        avg_volume = pick(
            info.get("averageVolume"),
            fast_info.get("threeMonthAverageVolume"),
            fast_info.get("tenDayAverageVolume"),
            avg_volume_calc
        )
        volume = pick(info.get("volume"), fast_info.get("volume"), last_volume)
        fiftyTwoWeekLow = pick(info.get("fiftyTwoWeekLow"), fast_info.get("fiftyTwoWeekLow"), year_low)
        fiftyTwoWeekHigh = pick(info.get("fiftyTwoWeekHigh"), fast_info.get("fiftyTwoWeekHigh"), year_high)

        trailing_eps = pick(info.get("trailingEps"), info.get("epsTrailingTwelveMonths"), info.get("eps"))
        net_income = pick(info.get("netIncomeToCommon"))
        if net_income is None:
            net_income = _first_from_stocks(fund_stocks, _get_net_income)
        if trailing_eps is None and net_income and shares_outstanding:
            try:
                trailing_eps = float(net_income) / float(shares_outstanding)
            except Exception:
                trailing_eps = None
        forward_eps = pick(info.get("forwardEps"), info.get("epsForward"))
        if forward_eps is None:
            try:
                growth = info.get("earningsGrowth") or info.get("earningsQuarterlyGrowth")
                if growth is not None and trailing_eps is not None:
                    forward_eps = float(trailing_eps) * (1 + float(growth))
            except Exception:
                forward_eps = None
        if forward_eps is None and trailing_eps is not None:
            forward_eps = trailing_eps

        pe_ratio = pick(info.get("trailingPE"))
        if pe_ratio is None and trailing_eps and trailing_eps > 0:
            pe_ratio = round(current_price / trailing_eps, 2)
        if pe_ratio is None and forward_eps and forward_eps > 0:
            pe_ratio = round(current_price / forward_eps, 2)
        if pe_ratio is not None and pe_ratio <= 0:
            pe_ratio = None

        forward_pe = pick(info.get("forwardPE"))
        if forward_pe is None and forward_eps and forward_eps > 0:
            forward_pe = round(current_price / forward_eps, 2)
        if forward_pe is not None and forward_pe <= 0:
            forward_pe = None

        dividend_rate = pick(info.get("dividendRate"), info.get("trailingAnnualDividendRate"))
        if dividend_rate is None:
            for _, cand_stock in fund_stocks:
                try:
                    div = cand_stock.dividends
                    if div is not None and not div.empty:
                        cutoff = datetime.now() - timedelta(days=365)
                        div_last_year = div[div.index >= cutoff]
                        if not div_last_year.empty:
                            dividend_rate = float(div_last_year.sum())
                            break
                except Exception:
                    continue
        dividend_yield = pick(info.get("dividendYield"))
        if dividend_yield is None and dividend_rate and current_price:
            dividend_yield = dividend_rate / current_price

        price_to_book = pick(info.get("priceToBook"))
        book_value = info.get("bookValue")
        if book_value is None and shares_outstanding:
            total_equity = _first_from_stocks(fund_stocks, _get_total_equity)
            if total_equity is not None and shares_outstanding:
                try:
                    book_value = float(total_equity) / float(shares_outstanding)
                except Exception:
                    book_value = None
        if price_to_book is None and book_value:
            try:
                price_to_book = round(current_price / float(book_value), 2)
            except Exception:
                price_to_book = None

        price_to_sales = pick(info.get("priceToSalesTrailing12Months"))
        total_revenue = info.get("totalRevenue")
        if total_revenue is None:
            total_revenue = _first_from_stocks(fund_stocks, _get_total_revenue)
        if price_to_sales is None and market_cap and total_revenue:
            try:
                price_to_sales = round(float(market_cap) / float(total_revenue), 2)
            except Exception:
                price_to_sales = None
        if price_to_sales is None and total_revenue and shares_outstanding:
            try:
                revenue_per_share = float(total_revenue) / float(shares_outstanding)
                if revenue_per_share:
                    price_to_sales = round(float(current_price) / revenue_per_share, 2)
            except Exception:
                price_to_sales = None

        beta = info.get("beta")
        if beta is None:
            try:
                t_hist_beta = None
                if not hist.empty and yf_interval == "1d":
                    t_hist_beta = hist.tail(252)
                if t_hist_beta is None or t_hist_beta.empty:
                    t_hist_beta = safe_history(stock, period="1y", interval="1d")
                m_hist = safe_history(yf.Ticker("SPY"), period="1y", interval="1d")
                if m_hist.empty:
                    m_hist = safe_history(yf.Ticker("^GSPC"), period="1y", interval="1d")
                if not t_hist_beta.empty and not m_hist.empty:
                    t_ret = t_hist_beta["Close"].pct_change().dropna()
                    m_ret = m_hist["Close"].pct_change().dropna()
                    t_ret, m_ret = t_ret.align(m_ret, join="inner")
                    if len(t_ret) > 10 and m_ret.var() > 0:
                        beta = round(t_ret.cov(m_ret) / m_ret.var(), 2)
            except Exception:
                beta = None

        # aggiorna info per coerenza
        if beta is not None:
            info["beta"] = beta
        if market_cap is not None:
            info["marketCap"] = market_cap
        if avg_volume is not None:
            info["averageVolume"] = avg_volume

        ohlc_data = [
            {
                "date": idx.strftime("%Y-%m-%d %H:%M") if "m" in yf_interval else idx.strftime("%Y-%m-%d"),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"])
            }
            for idx, row in hist.iterrows()
        ]

        closes = hist["Close"].tolist()
        close_series = pd.Series(closes)

        # Performance
        def calc_return(days):
            if len(closes) > days:
                old = closes[-days - 1]
                return round(((closes[-1] - old) / old) * 100, 2)
            return None

        daily_returns = close_series.pct_change().dropna()
        trading_days = 252

        def annualized_vol(returns):
            if returns is None or len(returns) < 2:
                return None
            return round(returns.std() * np.sqrt(trading_days) * 100, 2)

        def annualized_return(returns):
            if returns is None or len(returns) == 0:
                return None
            return (1 + returns.mean()) ** trading_days - 1

        volatility = annualized_vol(daily_returns)
        volatility_30d = annualized_vol(daily_returns.tail(30)) if len(daily_returns) >= 30 else None
        volatility_1y = annualized_vol(daily_returns.tail(252)) if len(daily_returns) >= 252 else None

        max_drawdown_1y = None
        if len(close_series) >= 252:
            last_year = close_series.tail(252)
            roll_max = last_year.cummax()
            drawdown = (last_year / roll_max) - 1
            max_drawdown_1y = round(drawdown.min() * 100, 2)

        risk_free_rate = 0.01
        returns_1y = daily_returns.tail(252) if len(daily_returns) >= 252 else daily_returns
        ann_ret_1y = annualized_return(returns_1y)
        vol_1y_decimal = (volatility_1y / 100) if volatility_1y is not None else None

        sharpe_ratio = None
        if ann_ret_1y is not None and vol_1y_decimal and vol_1y_decimal > 0:
            sharpe_ratio = round((ann_ret_1y - risk_free_rate) / vol_1y_decimal, 2)

        downside = returns_1y[returns_1y < 0]
        downside_dev = downside.std() * np.sqrt(trading_days) if len(downside) > 1 else None
        sortino_ratio = None
        if ann_ret_1y is not None and downside_dev and downside_dev > 0:
            sortino_ratio = round((ann_ret_1y - risk_free_rate) / downside_dev, 2)

        performance = {
            "return1Y": calc_return(252),
            "return3Y": calc_return(252*3),
            "return5Y": calc_return(252*5),
            "volatility": volatility,
            "momentum1M": calc_return(21),
            "momentum3M": calc_return(63),
            "volatility30D": volatility_30d,
            "volatility1Y": volatility_1y,
            "maxDrawdown1Y": max_drawdown_1y,
            "sharpeRatio": sharpe_ratio,
            "sortinoRatio": sortino_ratio
        }

        # --- Risk index (composite) ---
        def _to_num(v):
            try:
                return float(v) if v is not None else None
            except Exception:
                return None

        def _clamp01(v):
            return max(0.0, min(1.0, v))

        vol1y = _to_num(performance.get("volatility"))
        vol30 = _to_num(performance.get("volatility30D"))
        drawdown = _to_num(performance.get("maxDrawdown1Y"))
        beta = _to_num(info.get("beta"))
        sharpe = _to_num(performance.get("sharpeRatio"))
        sortino = _to_num(performance.get("sortinoRatio"))
        avg_volume_num = _to_num(avg_volume) or _to_num(volume)
        market_cap_num = _to_num(market_cap)
        avg_dollar_volume = None
        if avg_volume_num is not None and current_price is not None:
            avg_dollar_volume = avg_volume_num * current_price
        vol_regime = vol30 / vol1y if (vol30 is not None and vol1y is not None and vol1y > 0) else None

        vol_score = _clamp01((vol1y - 15) / 25) if vol1y is not None else None
        vol30_score = _clamp01((vol30 - 15) / 25) if vol30 is not None else None
        dd_score = _clamp01((abs(drawdown) - 10) / 25) if drawdown is not None else None
        beta_score = _clamp01((beta - 0.9) / 0.6) if beta is not None else None
        sharpe_score = _clamp01((1.2 - sharpe) / 1.2) if sharpe is not None else None
        sortino_score = _clamp01((1.4 - sortino) / 1.4) if sortino is not None else None

        def _log10(v):
            return np.log10(v) if v and v > 0 else None

        liquidity_score = None
        liquidity_base = avg_dollar_volume if avg_dollar_volume is not None else avg_volume_num
        if liquidity_base is not None:
            lv = _log10(liquidity_base)
            if lv is not None:
                low = 6.3 if avg_dollar_volume is not None else 5.5
                high = 7.3 if avg_dollar_volume is not None else 6.5
                liquidity_score = _clamp01((high - lv) / (high - low))

        size_score = None
        if market_cap_num is not None:
            lv = _log10(market_cap_num)
            if lv is not None:
                low = 9.3   # 2e9
                high = 10.0 # 1e10
                size_score = _clamp01((high - lv) / (high - low))

        regime_score = _clamp01((vol_regime - 1) / 0.6) if vol_regime is not None else None

        parts = [
            (vol_score, 0.20),
            (vol30_score, 0.10),
            (dd_score, 0.20),
            (beta_score, 0.10),
            (sharpe_score, 0.10),
            (sortino_score, 0.10),
            (liquidity_score, 0.10),
            (size_score, 0.05),
            (regime_score, 0.05),
        ]
        parts = [(v, w) for v, w in parts if v is not None]
        if parts:
            weight_sum = sum(w for _, w in parts)
            risk_index = round((sum(v * w for v, w in parts) / weight_sum) * 100)
        else:
            risk_index = None

        if risk_index is None:
            risk_level = "N/D"
        elif risk_index >= 67:
            risk_level = "Alto"
        elif risk_index >= 34:
            risk_level = "Medio"
        else:
            risk_level = "Basso"

        risk = {
            "version": "v1",
            "level": risk_level,
            "index": risk_index,
            "metrics": {
                "vol1y": vol1y,
                "vol30": vol30,
                "drawdown": drawdown,
                "beta": beta,
                "sharpe": sharpe,
                "sortino": sortino,
                "avgDollarVolume": avg_dollar_volume,
                "avgVolume": avg_volume_num,
                "marketCap": market_cap_num,
                "volRegime": vol_regime
            }
        }

        response = {
            "info": {
                "shortName": info.get("shortName") or ticker.upper(),
                "sector": info.get("sector") or "N/A",
                "currentPrice": current_price,
                "dailyLow": daily_low,
                "dailyHigh": daily_high,
                "dailyChange": daily_change,
                "marketCap": market_cap,
                "peRatio": pe_ratio,
                "forwardPE": forward_pe,
                "eps": trailing_eps,
                "epsForward": forward_eps,
                "dividend": dividend_rate,
                "dividendYield": dividend_yield,
                "beta": beta,
                "volume": volume,
                "52WLow": fiftyTwoWeekLow,
                "52WHigh": fiftyTwoWeekHigh,
                "averageVolume": avg_volume,
                "priceToSalesTrailing12Months": price_to_sales,
                "priceToBook": price_to_book,
            },
            "ohlc": ohlc_data,
            "performance": performance,
            "risk": risk
        }

        stock_response_cache[cache_key] = (response, datetime.utcnow())
        return jsonify(response)

    except Exception as e:
        print("ERRORE BACKEND:", e)
        return jsonify({"error": "Errore Server"}), 500


# -------------------------------
# Endpoint tecnici stile TradingView
# -------------------------------
@app.route("/stock/<ticker>/technicals")
def get_technicals(ticker):
    raw_ticker = ticker
    timeframe = request.args.get("timeframe", "1d")
    interval = TF_MAPPING.get(timeframe, "1d")
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"{cache_symbol}:{timeframe}"
    cached = _cache_get(technicals_cache, cache_key, TECHNICALS_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)

    try:
        if interval.endswith("m"):
            period = "60d"
            chart_range = "60d"
        elif interval == "1d":
            period = "2y"
            chart_range = "5y"
        elif interval == "1wk":
            period = "5y"
            chart_range = "10y"
        else:
            period = "20y"
            chart_range = "20y"

        hist = pd.DataFrame()
        stock = None
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            hist = _fetch_interval_history(cand, stock, period, interval, chart_range)
            if not hist.empty:
                ticker = cand
                break
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        for col in ("Open", "High", "Low", "Close", "Volume"):
            if col not in hist.columns:
                hist[col] = np.nan
        hist["Close"] = pd.to_numeric(hist["Close"], errors="coerce")
        hist["Low"] = pd.to_numeric(hist["Low"], errors="coerce").fillna(hist["Close"])
        hist["High"] = pd.to_numeric(hist["High"], errors="coerce").fillna(hist["Close"])
        hist["Volume"] = pd.to_numeric(hist["Volume"], errors="coerce").fillna(0)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        close = hist["Close"].astype(float)
        high = hist["High"].astype(float)
        low = hist["Low"].astype(float)
        volume = hist["Volume"].astype(float)

        # ---------- Medie mobili ----------
        ma_summary = []
        ma_periods = [10, 20, 50, 100, 200]
        ma_periods = [p for p in ma_periods if len(close) >= p]

        # SMA ed EMA già presenti
        for period in ma_periods:
            sma = close.rolling(window=period).mean().bfill().iloc[-1]
            action = "Buy" if close.iloc[-1] > sma else "Sell" if close.iloc[-1] < sma else "Neutral"
            ma_summary.append({"name": f"SMA{period}", "value": round(sma,2), "action": action})

            ema = close.ewm(span=period, adjust=False).mean().iloc[-1]
            action = "Buy" if close.iloc[-1] > ema else "Sell" if close.iloc[-1] < ema else "Neutral"
            ma_summary.append({"name": f"EMA{period}", "value": round(ema,2), "action": action})

        # WMA, HMA, TEMA
        for period in ma_periods:
            # WMA
            weights = np.arange(1, period+1)
            wma = (close.rolling(period).apply(lambda prices: np.dot(prices, weights)/weights.sum(), raw=True)).iloc[-1]
            action = "Buy" if close.iloc[-1] > wma else "Sell" if close.iloc[-1] < wma else "Neutral"
            ma_summary.append({"name": f"WMA{period}", "value": round(wma,2), "action": action})

            # HMA
            half_len = int(period/2)
            sqrt_len = int(np.sqrt(period))
            wma_half = close.rolling(half_len).apply(lambda x: np.dot(x, np.arange(1,half_len+1))/np.sum(np.arange(1,half_len+1)), raw=True)
            wma_full = close.rolling(period).apply(lambda x: np.dot(x, np.arange(1,period+1))/np.sum(np.arange(1,period+1)), raw=True)
            hma = (2*wma_half - wma_full).rolling(sqrt_len).mean().iloc[-1]
            action = "Buy" if close.iloc[-1] > hma else "Sell" if close.iloc[-1] < hma else "Neutral"
            ma_summary.append({"name": f"HMA{period}", "value": round(hma,2), "action": action})

            # TEMA
            ema1 = close.ewm(span=period, adjust=False).mean()
            ema2 = ema1.ewm(span=period, adjust=False).mean()
            ema3 = ema2.ewm(span=period, adjust=False).mean()
            tema = (3*ema1 - 3*ema2 + ema3).iloc[-1]
            action = "Buy" if close.iloc[-1] > tema else "Sell" if close.iloc[-1] < tema else "Neutral"
            ma_summary.append({"name": f"TEMA{period}", "value": round(tema,2), "action": action})

        # ---------- Oscillatori ----------
        oscillators = []

        # RSI, MACD, Stochastic, ATR, CCI, ADX, Williams, ROC, Momentum già presenti
        delta = close.diff()
        up = delta.clip(lower=0)
        down = -delta.clip(upper=0)
        roll_up = up.rolling(14).mean()
        roll_down = down.rolling(14).mean()
        rsi14 = 100 - 100/(1 + roll_up/roll_down)
        last_rsi = rsi14.iloc[-1]
        rsi_action = "Sell" if last_rsi>70 else "Buy" if last_rsi<30 else "Neutral"
        oscillators.append({"name":"RSI14","value":round(last_rsi,2),"action":rsi_action})

        ema12 = close.ewm(span=12, adjust=False).mean()
        ema26 = close.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        macd_action = "Buy" if macd.iloc[-1]>signal.iloc[-1] else "Sell" if macd.iloc[-1]<signal.iloc[-1] else "Neutral"
        oscillators.append({"name":"MACD","value":round(macd.iloc[-1],2),"action":macd_action})

        low14 = low.rolling(14).min()
        high14 = high.rolling(14).max()
        stochastic = 100*(close-low14)/(high14-low14)
        stoch_action = "Sell" if stochastic.iloc[-1]>80 else "Buy" if stochastic.iloc[-1]<20 else "Neutral"
        oscillators.append({"name":"Stochastic14","value":round(stochastic.iloc[-1],2),"action":stoch_action})

        # ATR14
        tr = pd.concat([high-low, abs(high-close.shift(1)), abs(low-close.shift(1))], axis=1).max(axis=1)
        atr14 = tr.rolling(14).mean()
        oscillators.append({"name":"ATR14","value":round(atr14.iloc[-1],2),"action":"Neutral"})

        # CCI20
        tp = (high+low+close)/3
        sma_tp = tp.rolling(20).mean()
        mean_dev = tp.rolling(20).apply(lambda x: np.mean(np.abs(x-np.mean(x))), raw=True)
        cci = (tp - sma_tp)/(0.015*mean_dev)
        cci_action = "Buy" if cci.iloc[-1]<-100 else "Sell" if cci.iloc[-1]>100 else "Neutral"
        oscillators.append({"name":"CCI20","value":round(cci.iloc[-1],2),"action":cci_action})

        # ADX14
        plus_dm = high.diff()
        minus_dm = -low.diff()
        plus_dm[plus_dm<0]=0
        minus_dm[minus_dm<0]=0
        tr = pd.concat([high-low, abs(high-close.shift(1)), abs(low-close.shift(1))], axis=1).max(axis=1)
        plus_di = 100*(plus_dm.rolling(14).sum()/tr.rolling(14).sum())
        minus_di = 100*(minus_dm.rolling(14).sum()/tr.rolling(14).sum())
        dx = (abs(plus_di-minus_di)/(plus_di+minus_di))*100
        adx = dx.rolling(14).mean()
        adx_action = "Tendenza Forte" if adx.iloc[-1]>25 else "Neutro"
        oscillators.append({"name":"ADX14","value":round(adx.iloc[-1],2),"action":adx_action})

        # Williams %R14
        willr = -100*(high14-close)/(high14-low14)
        willr_action = "Sell" if willr.iloc[-1]>-20 else "Buy" if willr.iloc[-1]<-80 else "Neutral"
        oscillators.append({"name":"WilliamsR14","value":round(willr.iloc[-1],2),"action":willr_action})

        # ROC12
        roc12 = (close-close.shift(12))/close.shift(12)*100
        roc12_action = "Buy" if roc12.iloc[-1]>0 else "Sell" if roc12.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"ROC12","value":round(roc12.iloc[-1],2),"action":roc12_action})

        # Momentum10
        mom10 = close - close.shift(10)
        mom10_action = "Buy" if mom10.iloc[-1]>0 else "Sell" if mom10.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"Momentum10","value":round(mom10.iloc[-1],2),"action":mom10_action})

        # Momentum3M
        mom3M = close - close.shift(63)
        last_mom3M = 0 if pd.isna(mom3M.iloc[-1]) else mom3M.iloc[-1]
        mom3M_action = "Buy" if last_mom3M>0 else "Sell" if last_mom3M<0 else "Neutral"
        oscillators.append({"name":"Momentum3M","value":round(last_mom3M,2),"action":mom3M_action})

        # ------------------ 11 Oscillatori Aggiuntivi ------------------
        # TRIX15
        ema1 = close.ewm(span=15, adjust=False).mean()
        ema2 = ema1.ewm(span=15, adjust=False).mean()
        ema3 = ema2.ewm(span=15, adjust=False).mean()
        trix = ema3.pct_change()*100
        trix_action = "Buy" if trix.iloc[-1]>0 else "Sell" if trix.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"TRIX15","value":round(trix.iloc[-1],2),"action":trix_action})

        # Ultimate Oscillator
        bp = close - low.rolling(1).min()
        tr_uo = high.rolling(1).max() - low.rolling(1).min()
        avg7 = bp.rolling(7).sum()/tr_uo.rolling(7).sum()
        avg14 = bp.rolling(14).sum()/tr_uo.rolling(14).sum()
        avg28 = bp.rolling(28).sum()/tr_uo.rolling(28).sum()
        uo = 100*(4*avg7 + 2*avg14 + avg28)/7
        uo_action = "Sell" if uo.iloc[-1]>70 else "Buy" if uo.iloc[-1]<30 else "Neutral"
        oscillators.append({"name":"UltimateOsc","value":round(uo.iloc[-1],2),"action":uo_action})

        # CCI50
        tp50 = (high+low+close)/3
        sma_tp50 = tp50.rolling(50).mean()
        mean_dev50 = tp50.rolling(50).apply(lambda x: np.mean(np.abs(x-np.mean(x))), raw=True)
        cci50 = (tp50 - sma_tp50)/(0.015*mean_dev50)
        cci50_action = "Buy" if cci50.iloc[-1]<-100 else "Sell" if cci50.iloc[-1]>100 else "Neutral"
        oscillators.append({"name":"CCI50","value":round(cci50.iloc[-1],2),"action":cci50_action})

        # RSI7
        up7 = delta.clip(lower=0)
        down7 = -delta.clip(upper=0)
        rsi7 = 100-100/(1+up7.rolling(7).mean()/down7.rolling(7).mean())
        rsi7_action = "Sell" if rsi7.iloc[-1]>70 else "Buy" if rsi7.iloc[-1]<30 else "Neutral"
        oscillators.append({"name":"RSI7","value":round(rsi7.iloc[-1],2),"action":rsi7_action})

        # RSI21
        up21 = delta.clip(lower=0)
        down21 = -delta.clip(upper=0)
        rsi21 = 100-100/(1+up21.rolling(21).mean()/down21.rolling(21).mean())
        rsi21_action = "Sell" if rsi21.iloc[-1]>70 else "Buy" if rsi21.iloc[-1]<30 else "Neutral"
        oscillators.append({"name":"RSI21","value":round(rsi21.iloc[-1],2),"action":rsi21_action})

        # Stochastic Slow 14,3
        k_slow = 100*(close-low.rolling(14).min())/(high.rolling(14).max()-low.rolling(14).min())
        d_slow = k_slow.rolling(3).mean()
        stoch_slow_action = "Sell" if k_slow.iloc[-1]>80 else "Buy" if k_slow.iloc[-1]<20 else "Neutral"
        oscillators.append({"name":"StochSlow","value":round(k_slow.iloc[-1],2),"action":stoch_slow_action})

        # Williams %R50
        willr50 = -100*(high.rolling(50).max()-close)/(high.rolling(50).max()-low.rolling(50).min())
        willr50_action = "Sell" if willr50.iloc[-1]>-20 else "Buy" if willr50.iloc[-1]<-80 else "Neutral"
        oscillators.append({"name":"WilliamsR50","value":round(willr50.iloc[-1],2),"action":willr50_action})

        # MACD Histogram
        macd_hist = macd - signal
        macd_hist_action = "Buy" if macd_hist.iloc[-1]>0 else "Sell" if macd_hist.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"MACD_Hist","value":round(macd_hist.iloc[-1],2),"action":macd_hist_action})

        # ROC6
        roc6 = (close-close.shift(6))/close.shift(6)*100
        roc6_action = "Buy" if roc6.iloc[-1]>0 else "Sell" if roc6.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"ROC6","value":round(roc6.iloc[-1],2),"action":roc6_action})

        # Momentum20
        mom20 = close-close.shift(20)
        mom20_action = "Buy" if mom20.iloc[-1]>0 else "Sell" if mom20.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"Momentum20","value":round(mom20.iloc[-1],2),"action":mom20_action})

        # CMF20
        mf = ((close-low)-(high-close))/(high-low)*volume
        cmf20 = mf.rolling(20).sum()/volume.rolling(20).sum()
        cmf20_action = "Buy" if cmf20.iloc[-1]>0 else "Sell" if cmf20.iloc[-1]<0 else "Neutral"
        oscillators.append({"name":"CMF20","value":round(cmf20.iloc[-1],2),"action":cmf20_action})

        # ---------- Segnali generali ----------
        ma_buy_count = sum(1 for x in ma_summary if x["action"]=="Buy")
        ma_sell_count = sum(1 for x in ma_summary if x["action"]=="Sell")
        osc_buy_count = sum(1 for x in oscillators if x["action"]=="Buy")
        osc_sell_count = sum(1 for x in oscillators if x["action"]=="Sell")

        ma_signal = "Neutral"
        if ma_buy_count>ma_sell_count: ma_signal="Buy"
        elif ma_sell_count>ma_buy_count: ma_signal="Sell"

        osc_signal = "Neutral"
        if osc_buy_count>osc_sell_count: osc_signal="Buy"
        elif osc_sell_count>osc_buy_count: osc_signal="Sell"

        general_signal = "Neutral"
        if ma_signal=="Buy" and osc_signal=="Buy": general_signal="Buy"
        elif ma_signal=="Sell" and osc_signal=="Sell": general_signal="Sell"

        response = {
            "overall": general_signal,
            "movingAveragesSummary": ma_summary,
            "oscillatorsSummary": oscillators,
            "maSignal": ma_signal,
            "oscSignal": osc_signal
        }
        _cache_set(technicals_cache, cache_key, response)
        return jsonify(response)

    except Exception as e:
        print("Errore tecnici:", e)
        return jsonify({"error":"Errore nel recupero dati tecnici"}),500










# -------------------------------
# Endpoint notizie Yahoo Finance RSS
# -------------------------------
@app.route("/stock/<ticker>/news")
def get_stock_news(ticker):
    try:
        def _normalize_for_news(sym):
            if not sym:
                return sym
            s = sym.upper().strip()
            s = re.sub(r"^[0-9]+", "", s)
            known_suffixes = [
                ".MI", ".L", ".DE", ".PA", ".TO", ".V", ".SW", ".AS", ".MC",
                ".SA", ".HK", ".SS", ".SZ", ".AX", ".KS", ".KQ", ".TW", ".T", ".SI"
            ]
            for suf in known_suffixes:
                if s.endswith(suf):
                    s = s[: -len(suf)]
                    break
            return s

        def _news_locale_for_ticker(sym):
            sym = (sym or "").upper()
            if sym.endswith(".MI"):
                return ("IT", "it-IT")
            if sym.endswith(".L"):
                return ("GB", "en-GB")
            if sym.endswith(".DE"):
                return ("DE", "de-DE")
            if sym.endswith(".PA"):
                return ("FR", "fr-FR")
            if sym.endswith(".TO") or sym.endswith(".V"):
                return ("CA", "en-CA")
            return ("US", "en-US")
        def _rss_items(sym):
            region, lang = _news_locale_for_ticker(sym)
            rss_url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region={region}&lang={lang}"
            feed = feedparser.parse(rss_url)
            items = []
            for entry in feed.entries[:100]:
                pub_date = None
                if hasattr(entry, "published_parsed") and entry.published_parsed:
                    pub_date = datetime(*entry.published_parsed[:6]).isoformat()
                items.append({
                    "title": entry.title,
                    "link": entry.link,
                    "published": pub_date
                })
            return items

        news_items = _rss_items(ticker)
        used_ticker = ticker
        if not news_items:
            try:
                yf_news = yf.Ticker(ticker).news or []
                for item in yf_news:
                    pub_date = None
                    if item.get("providerPublishTime"):
                        pub_date = datetime.fromtimestamp(item["providerPublishTime"]).isoformat()
                    news_items.append({
                        "title": item.get("title"),
                        "link": item.get("link") or item.get("url"),
                        "published": pub_date
                    })
            except Exception as e:
                print("Fallback news error:", e)

        
        if not news_items:
            alt_symbol = _normalize_for_news(ticker)
            if alt_symbol and alt_symbol != ticker:
                try:
                    news_items = _rss_items(alt_symbol)
                    if news_items:
                        used_ticker = alt_symbol
                except Exception as e:
                    print("Fallback RSS alt error:", e)

            if not news_items and alt_symbol and alt_symbol != ticker:
                try:
                    yf_news = yf.Ticker(alt_symbol).news or []
                    for item in yf_news:
                        pub_date = None
                        if item.get("providerPublishTime"):
                            pub_date = datetime.fromtimestamp(item["providerPublishTime"]).isoformat()
                        news_items.append({
                            "title": item.get("title"),
                            "link": item.get("link") or item.get("url"),
                            "published": pub_date
                        })
                    if news_items:
                        used_ticker = alt_symbol
                except Exception as e:
                    print("Fallback yfinance alt error:", e)

        return jsonify({"news": news_items, "source_ticker": used_ticker})

    except Exception as e:
        print("Errore news:", e)
        return jsonify({"news": [], "error": "Errore nel recupero delle notizie"}), 500

    


# ---------------------------------------------------------
# Partial Correlation + Normal Correlation Matrix (Indicators vs Returns)
# ---------------------------------------------------------
@app.route("/stock/<ticker>/partial_corr")
def get_partial_and_normal_corr(ticker):
    cache_symbol = (ticker or "").strip().upper().replace(" ", "")
    cache_key = f"matrix:{cache_symbol}"
    cached = _cache_get(partial_corr_cache, cache_key, PARTIAL_CORR_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        raw_ticker = ticker
        hist = pd.DataFrame()
        stock = None
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            hist = safe_history(stock, period="10y", interval="1d")
            if hist.empty:
                hist = safe_history(stock, period="5y", interval="1d")
            if hist.empty:
                hist = safe_history(stock, period="2y", interval="1d")
            if hist.empty:
                hist = safe_download(
                    cand, period="10y", interval="1d",
                    progress=False, threads=False
                )
            if hist.empty:
                hist = safe_download(
                    cand, period="5y", interval="1d",
                    progress=False, threads=False
                )
            if hist.empty:
                hist, _ = _fetch_chart_data(cand, "10y", "1d")
            if hist.empty:
                hist, _ = _fetch_chart_data(cand, "5y", "1d")
            if not hist.empty:
                ticker = cand
                break
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        for col in ("Open", "High", "Low", "Close", "Volume"):
            if col not in hist.columns:
                hist[col] = np.nan
        hist["Close"] = pd.to_numeric(hist["Close"], errors="coerce")
        hist["Low"] = pd.to_numeric(hist["Low"], errors="coerce").fillna(hist["Close"])
        hist["High"] = pd.to_numeric(hist["High"], errors="coerce").fillna(hist["Close"])
        hist["Volume"] = pd.to_numeric(hist["Volume"], errors="coerce").fillna(0)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        close = hist["Close"].astype(float)
        high = hist["High"].astype(float)
        low = hist["Low"].astype(float)
        volume = hist["Volume"].astype(float)

        df = pd.DataFrame()

        # ---------- Returns ----------
        df["Return_1W"] = close.pct_change(5) * 100
        df["Return_1M"] = close.pct_change(21) * 100
        df["Return_3M"] = close.pct_change(63) * 100
        df["Return_1Y"] = close.pct_change(252) * 100
        df["Return_5Y"] = close.pct_change(252*5) * 100

        # ---------- Medie mobili principali ----------
        ma_periods = [10, 50, 200]
        for period in ma_periods:
            df[f"SMA{period}"] = close.rolling(period).mean()
            df[f"EMA{period}"] = close.ewm(span=period, adjust=False).mean()

        # ---------- Oscillatori principali ----------
        delta = close.diff()
        up = delta.clip(lower=0)
        down = -delta.clip(upper=0)
        df["RSI14"] = 100 - 100 / (1 + up.rolling(14).mean()/down.rolling(14).mean())

        ema12 = close.ewm(span=12, adjust=False).mean()
        ema26 = close.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        df["MACD"] = macd
        df["MACD_Hist"] = macd - signal

        low14 = low.rolling(14).min()
        high14 = high.rolling(14).max()
        df["Stochastic14"] = 100*(close-low14)/(high14-low14)
        df["WilliamsR14"] = -100*(high14-close)/(high14-low14)

        tp = (high+low+close)/3
        sma_tp20 = tp.rolling(20).mean()
        mean_dev20 = tp.rolling(20).apply(lambda x: np.mean(np.abs(x-np.mean(x))), raw=True)
        df["CCI20"] = (tp - sma_tp20)/(0.015*mean_dev20)

        tr = pd.concat([high-low, abs(high-close.shift(1)), abs(low-close.shift(1))], axis=1).max(axis=1)
        plus_dm = high.diff()
        minus_dm = -low.diff()
        plus_dm[plus_dm<0]=0
        minus_dm[minus_dm<0]=0
        plus_di = 100*(plus_dm.rolling(14).sum()/tr.rolling(14).sum())
        minus_di = 100*(minus_dm.rolling(14).sum()/tr.rolling(14).sum())
        dx = (abs(plus_di-minus_di)/(plus_di+minus_di))*100
        df["ADX14"] = dx.rolling(14).mean()

        df["ROC12"] = (close-close.shift(12))/close.shift(12)*100

        # ---------- MOMENTUM AGGIORNATI ----------
        df["Momentum10"] = close - close.shift(10)
        df["Momentum20"] = close - close.shift(20)
        df["Momentum3M"] = close - close.shift(63)

        # TRIX15
        ema_trix1 = close.ewm(span=15, adjust=False).mean()
        ema_trix2 = ema_trix1.ewm(span=15, adjust=False).mean()
        ema_trix3 = ema_trix2.ewm(span=15, adjust=False).mean()
        df["TRIX15"] = ema_trix3.pct_change()*100

        # CMF20
        mf = ((close-low)-(high-close))/(high-low)*volume
        df["CMF20"] = mf.rolling(20).sum()/volume.rolling(20).sum()

        # Ultimate Oscillator
        bp = close - low.rolling(1).min()
        tr_uo = high.rolling(1).max() - low.rolling(1).min()
        avg7 = bp.rolling(7).sum()/tr_uo.rolling(7).sum()
        avg14 = bp.rolling(14).sum()/tr_uo.rolling(14).sum()
        avg28 = bp.rolling(28).sum()/tr_uo.rolling(28).sum()
        df["UltimateOsc"] = 100*(4*avg7 + 2*avg14 + avg28)/7

        # ---------- Drop NaN ----------
        df = df.dropna()
        if df.empty or len(df) < 50:
            return jsonify({"error": "Dati insufficienti per correlazione"}), 404

        # ---------- Partial correlation ----------
        from sklearn.covariance import GraphicalLassoCV
        model = GraphicalLassoCV()
        model.fit(df)
        precision = model.precision_
        D = np.diag(1 / np.sqrt(np.diag(precision)))
        partial_corr = -D @ precision @ D
        np.fill_diagonal(partial_corr, 1)

        # ---------- Normal correlation ----------
        normal_corr = df.corr().values

        response = {
            "variables": df.columns.tolist(),
            "partial_matrix": partial_corr.tolist(),
            "normal_matrix": normal_corr.tolist()
        }
        _cache_set(partial_corr_cache, cache_key, response, max_size=180)
        return jsonify(response)

    except Exception as e:
        print("Errore partial_corr:", e)
        return jsonify({"error": "Errore nel calcolo della correlazione"}), 500



    

@app.route("/stock/<ticker>/partial_corr_table")
def get_partial_corr_table(ticker):
    cache_symbol = (ticker or "").strip().upper().replace(" ", "")
    cache_key = f"table:{cache_symbol}"
    cached = _cache_get(partial_corr_cache, cache_key, PARTIAL_CORR_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        raw_ticker = ticker
        hist = pd.DataFrame()
        stock = None
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            hist = safe_history(stock, period="10y", interval="1d")
            if hist.empty:
                hist = safe_history(stock, period="5y", interval="1d")
            if hist.empty:
                hist = safe_history(stock, period="2y", interval="1d")
            if hist.empty:
                hist = safe_download(
                    cand, period="10y", interval="1d",
                    progress=False, threads=False
                )
            if hist.empty:
                hist = safe_download(
                    cand, period="5y", interval="1d",
                    progress=False, threads=False
                )
            if hist.empty:
                hist, _ = _fetch_chart_data(cand, "10y", "1d")
            if hist.empty:
                hist, _ = _fetch_chart_data(cand, "5y", "1d")
            if not hist.empty:
                ticker = cand
                break
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        for col in ("Open", "High", "Low", "Close", "Volume"):
            if col not in hist.columns:
                hist[col] = np.nan
        hist["Close"] = pd.to_numeric(hist["Close"], errors="coerce")
        hist["Low"] = pd.to_numeric(hist["Low"], errors="coerce").fillna(hist["Close"])
        hist["High"] = pd.to_numeric(hist["High"], errors="coerce").fillna(hist["Close"])
        hist["Volume"] = pd.to_numeric(hist["Volume"], errors="coerce").fillna(0)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        close = hist["Close"].astype(float)
        high = hist["High"].astype(float)
        low = hist["Low"].astype(float)
        volume = hist["Volume"].astype(float)

        df = pd.DataFrame()

        # ---------- Returns ----------
        df["Return_1W"] = close.pct_change(5) * 100
        df["Return_1M"] = close.pct_change(21) * 100
        df["Return_3M"] = close.pct_change(63) * 100
        df["Return_1Y"] = close.pct_change(252) * 100
        df["Return_5Y"] = close.pct_change(252*5) * 100

        # ---------- Indicatori principali ----------
        ma_periods = [10, 50, 200]
        for period in ma_periods:
            df[f"SMA{period}"] = close.rolling(period).mean()
            df[f"EMA{period}"] = close.ewm(span=period, adjust=False).mean()

        delta = close.diff()
        up = delta.clip(lower=0)
        down = -delta.clip(upper=0)
        df["RSI14"] = 100 - 100 / (1 + up.rolling(14).mean()/down.rolling(14).mean())

        ema12 = close.ewm(span=12, adjust=False).mean()
        ema26 = close.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        df["MACD"] = macd
        df["MACD_Hist"] = macd - signal

        low14 = low.rolling(14).min()
        high14 = high.rolling(14).max()
        df["Stochastic14"] = 100*(close-low14)/(high14-low14)
        df["WilliamsR14"] = -100*(high14-close)/(high14-low14)

        tp = (high+low+close)/3
        sma_tp20 = tp.rolling(20).mean()
        mean_dev20 = tp.rolling(20).apply(lambda x: np.mean(np.abs(x-np.mean(x))), raw=True)
        df["CCI20"] = (tp - sma_tp20)/(0.015*mean_dev20)

        tr = pd.concat([high-low, abs(high-close.shift(1)), abs(low-close.shift(1))], axis=1).max(axis=1)
        plus_dm = high.diff()
        minus_dm = -low.diff()
        plus_dm[plus_dm<0]=0
        minus_dm[minus_dm<0]=0
        plus_di = 100*(plus_dm.rolling(14).sum()/tr.rolling(14).sum())
        minus_di = 100*(minus_dm.rolling(14).sum()/tr.rolling(14).sum())
        dx = (abs(plus_di-minus_di)/(plus_di+minus_di))*100
        df["ADX14"] = dx.rolling(14).mean()

        df["ROC12"] = (close-close.shift(12))/close.shift(12)*100
        df["Momentum10"] = close - close.shift(10)
        df["Momentum20"] = close - close.shift(20)
        df["Momentum3M"] = close - close.shift(63)

        # TRIX15
        ema_trix1 = close.ewm(span=15, adjust=False).mean()
        ema_trix2 = ema_trix1.ewm(span=15, adjust=False).mean()
        ema_trix3 = ema_trix2.ewm(span=15, adjust=False).mean()
        df["TRIX15"] = ema_trix3.pct_change()*100

        # CMF20
        mf = ((close-low)-(high-close))/(high-low)*volume
        df["CMF20"] = mf.rolling(20).sum()/volume.rolling(20).sum()

        # Ultimate Oscillator
        bp = close - low.rolling(1).min()
        tr_uo = high.rolling(1).max() - low.rolling(1).min()
        avg7 = bp.rolling(7).sum()/tr_uo.rolling(7).sum()
        avg14 = bp.rolling(14).sum()/tr_uo.rolling(14).sum()
        avg28 = bp.rolling(28).sum()/tr_uo.rolling(28).sum()
        df["UltimateOsc"] = 100*(4*avg7 + 2*avg14 + avg28)/7

        # ---------- Drop NaN ----------
        df = df.dropna()
        if df.empty or len(df) < 50:
            return jsonify({"error": "Dati insufficienti per correlazione"}), 404

        # ---------- Partial correlation ----------
        from sklearn.covariance import GraphicalLassoCV
        model = GraphicalLassoCV()
        model.fit(df)
        precision = model.precision_
        D = np.diag(1 / np.sqrt(np.diag(precision)))
        partial_corr = -D @ precision @ D
        np.fill_diagonal(partial_corr, 1)

        # ---------- Costruzione tabella compatta (solo valori diversi da 0) ----------
        columns = df.columns.tolist()
        table = []
        for i, var1 in enumerate(columns):
            for j, var2 in enumerate(columns):
                if i < j:  # metà matrice
                    value = round(partial_corr[i,j], 3)
                    if value != 0:
                        table.append({
                            "Variable 1": var1,
                            "Variable 2": var2,
                            "Partial Correlation": value
                        })

        # ---------- Evidenzia correlazione massima per ogni variabile ----------
        max_corr = {}
        for i, var1 in enumerate(columns):
            max_val = -np.inf
            max_j = None
            for j, var2 in enumerate(columns):
                if i != j:
                    val = abs(partial_corr[i,j])
                    if val > max_val:
                        max_val = val
                        max_j = var2
            if max_j:
                max_corr[var1] = {"variable": max_j, "value": round(partial_corr[i, columns.index(max_j)], 3)}

        response = {
            "partial_corr_table": table,
            "max_corr_per_variable": max_corr
        }
        _cache_set(partial_corr_cache, cache_key, response, max_size=180)
        return jsonify(response)

    except Exception as e:
        print("Errore partial_corr_table:", e)
        return jsonify({"error": "Errore nel calcolo della correlazione parziale"}), 500




# =========================================================
# UTILITY: Winsorizzazione e percentili
# =========================================================

def winsorize_list_daily(arr, p_min=0.05, p_max=0.95):
    """
    Winsorizza un array: valori sotto il quantile p_min -> min, sopra p_max -> max.
    Gestisce NaN/inf e preserva la lunghezza originale.
    """
    if arr is None:
        return arr
    vals = np.asarray(arr, dtype=float)
    if vals.size == 0:
        return vals
    mask = np.isfinite(vals)
    if mask.sum() == 0:
        return vals
    clean = vals[mask]
    try:
        min_val = float(np.nanquantile(clean, p_min))
        max_val = float(np.nanquantile(clean, p_max))
    except Exception:
        return vals
    if min_val > max_val:
        min_val, max_val = max_val, min_val
    clipped = vals[mask]
    clipped = np.where(clipped < min_val, min_val, clipped)
    clipped = np.where(clipped > max_val, max_val, clipped)
    vals[mask] = clipped
    return vals

def compute_percentiles(curves_by_year):
    percentiles = []
    for month_idx in range(12):
        vals = [
            year_curve[month_idx]
            for year_curve in curves_by_year.values()
            if year_curve[month_idx] is not None
        ]

        if not vals:
            percentiles.append({"p10": 0, "median": 0, "p90": 0})
            continue

        vals = sorted(vals)
        n = len(vals)

        p10 = vals[int(0.10 * (n - 1))]
        median = vals[int(0.50 * (n - 1))]
        p90 = vals[int(0.90 * (n - 1))]

        percentiles.append({
            "p10": round(p10, 2),
            "median": round(median, 2),
            "p90": round(p90, 2)
        })

    return percentiles



@app.route("/seasonality/<ticker>")
def get_seasonality(ticker):
    raw_ticker = ticker
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    exclude_outliers = request.args.get("exclude_outliers", "false").lower() == "true"
    cache_key = f"{cache_symbol}:outliers={exclude_outliers}"
    cached = _cache_get(seasonality_cache, cache_key, SEASONALITY_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        daily = pd.DataFrame()
        period_candidates = ["20y", "10y", "5y", "2y", "1y"]
        range_map = {"20y": "20y", "10y": "10y", "5y": "5y", "2y": "2y", "1y": "1y"}

        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            for period in period_candidates:
                daily = _fetch_interval_history(
                    cand, stock, period, "1d", range_map.get(period, "5y")
                )
                if not daily.empty:
                    ticker = cand
                    break
            if not daily.empty:
                break

        if daily.empty or len(daily) < 120:
            return jsonify({"error": "Dati insufficienti"}), 404

        monthly = _resample_ohlc(_normalize_ohlc_df(daily), "ME")
        if monthly.empty or len(monthly) < 6:
            return jsonify({"error": "Dati insufficienti"}), 404

        df = _normalize_ohlc_df(monthly).copy().sort_index()
        for col in ("Open", "Close"):
            if col not in df.columns:
                df[col] = np.nan
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.replace([np.inf, -np.inf], np.nan)
        df["Close"] = pd.to_numeric(df["Close"], errors="coerce")
        df = df.dropna(subset=["Open", "Close"])
        df = df[df["Open"] > 0]
        df["Month"] = df.index.month
        df["Year"] = df.index.year
        # TradingView-style stagionalità tabella: close mese vs close mese precedente.
        df["MonthlyReturnPct"] = df["Close"].pct_change() * 100.0

        current_year = datetime.now().year

        seasonal_curve_by_year = {}
        cumulative_curve_by_year = {}
        if exclude_outliers:
            valid = df["MonthlyReturnPct"].dropna()
            if not valid.empty:
                try:
                    q05 = float(np.nanquantile(valid.values, 0.05))
                    q95 = float(np.nanquantile(valid.values, 0.95))
                    if q05 > q95:
                        q05, q95 = q95, q05
                    df["MonthlyReturnPct"] = df["MonthlyReturnPct"].clip(lower=q05, upper=q95)
                except Exception:
                    pass

        # ================================
        # CALCOLO STAGIONALITÀ (TradingView style)
        # ================================
        for year, group in df.groupby("Year"):
            valid_months = int(group["MonthlyReturnPct"].notna().sum())
            if year != current_year and valid_months < 6:
                continue

            monthly_curve = [None] * 12
            cumulative_curve = [None] * 12
            cum_return = 0.0

            for _, row in group.iterrows():
                month = int(row["Month"])
                r = row["MonthlyReturnPct"]
                if pd.isna(r) or not np.isfinite(r):
                    continue
                monthly_curve[month - 1] = round(float(r), 2)

            for i in range(12):
                v = monthly_curve[i]
                if v is None:
                    cumulative_curve[i] = None
                    continue
                cum_return = (1 + cum_return) * (1 + (v / 100.0)) - 1
                cumulative_curve[i] = round(cum_return * 100, 2)

            if any(v is not None for v in monthly_curve):
                seasonal_curve_by_year[year] = monthly_curve
                cumulative_curve_by_year[year] = cumulative_curve

        if not seasonal_curve_by_year:
            return jsonify({"error": "Dati stagionalità insufficienti"}), 404

        # ================================
        # PERCENTILI
        # ================================
        monthly_percentiles = compute_percentiles(seasonal_curve_by_year)
        cumulative_percentiles = compute_percentiles(cumulative_curve_by_year)

        response = {
            "months": ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu",
                       "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
            "seasonalCurveByYear": seasonal_curve_by_year,
            "cumulativeCurveByYear": cumulative_curve_by_year,
            "monthlyPercentiles": monthly_percentiles,
            "cumulativePercentiles": cumulative_percentiles,
            "years": sorted(seasonal_curve_by_year.keys()),
            "excludeOutliers": exclude_outliers
        }
        _cache_set(seasonality_cache, cache_key, response, max_size=220)
        return jsonify(response)

    except Exception as e:
        print("Errore stagionalità:", e)
        return jsonify({"error": "Errore stagionalità"}), 500
    
# ---------------------- Supply/Demand Functions ----------------------
def calculate_supply_demand_zones(hist, bins=50, window=2, strength_percentile=75, pivot_source="close"):
    hist = hist.copy().ffill()
    price_min = hist['Low'].min()
    price_max = hist['High'].max()
    bin_edges = np.linspace(price_min, price_max, bins + 1)
    
    support_counts = np.zeros(bins)
    resistance_counts = np.zeros(bins)
    
    # ADL cumulativo
    price_range = hist['High'] - hist['Low']
    price_range[price_range == 0] = 1e-9
    adl = ((hist['Close'] - hist['Low']) - (hist['High'] - hist['Close'])) / price_range * hist['Volume']
    adl = adl.cumsum()
    
    # Pivot con finestra mobile
    for i in range(window, len(hist) - window):
        if pivot_source == "hilo":
            high_window = hist['High'].iloc[i - window:i + window + 1]
            low_window = hist['Low'].iloc[i - window:i + window + 1]
            price_today_high = hist['High'].iloc[i]
            price_today_low = hist['Low'].iloc[i]
            price_today = hist['Close'].iloc[i]
        else:
            price_window = hist['Close'].iloc[i - window:i + window + 1]
            price_today = hist['Close'].iloc[i]

        bin_idx = np.digitize(price_today, bin_edges) - 1
        bin_idx = max(0, min(bin_idx, bins - 1))

        if pivot_source == "hilo":
            if price_today_low == low_window.min():
                support_counts[bin_idx] += adl.iloc[i]
            if price_today_high == high_window.max():
                resistance_counts[bin_idx] += adl.iloc[i]
        else:
            if price_today == price_window.min():
                support_counts[bin_idx] += adl.iloc[i]
            elif price_today == price_window.max():
                resistance_counts[bin_idx] += adl.iloc[i]
    
    support_threshold = np.percentile(support_counts, strength_percentile)
    resistance_threshold = np.percentile(resistance_counts, strength_percentile)
    
    support_zones = []
    resistance_zones = []
    
    for i in range(bins):
        price_lower = bin_edges[i]
        price_upper = bin_edges[i + 1]
        price_mid = round(float((price_lower + price_upper) / 2), 2)
        
        if support_counts[i] >= support_threshold:
            support_zones.append({
                "price": price_mid,
                "min": round(price_lower, 2),
                "max": round(price_upper, 2),
            })
        if resistance_counts[i] >= resistance_threshold:
            resistance_zones.append({
                "price": price_mid,
                "min": round(price_lower, 2),
                "max": round(price_upper, 2),
            })
    
    return {"support": support_zones, "resistance": resistance_zones}

def determine_market_state(price, supports, resistances, proximity=1.5):
    nearest_support = max([s["price"] for s in supports if s["price"] <= price], default=None)
    nearest_resistance = min([r["price"] for r in resistances if r["price"] >= price], default=None)

    if nearest_support is None or nearest_resistance is None:
        return {"state": "IN_NONE", "strength": 0}

    dist_support = ((price - nearest_support) / nearest_support) * 100
    dist_resistance = ((nearest_resistance - price) / nearest_resistance) * 100

    strength = round(100 - min(dist_support, dist_resistance), 2)

    if dist_support < dist_resistance and dist_support < proximity:
        return {"state": "IN_DEMAND", "strength": strength}
    elif dist_resistance < dist_support and dist_resistance < proximity:
        return {"state": "IN_SUPPLY", "strength": strength}
    else:
        return {"state": "IN_NONE", "strength": strength}

def filter_zones_by_distance(zones, price, min_pct):
    if price <= 0 or min_pct <= 0:
        return zones

    min_abs = price * (min_pct / 100.0)
    supports = [s for s in zones["support"] if (price - s["price"]) >= min_abs]
    resistances = [r for r in zones["resistance"] if (r["price"] - price) >= min_abs]

    # Fallback: se filtriamo tutto, mantieni le zone originali
    if not supports:
        supports = zones["support"]
    if not resistances:
        resistances = zones["resistance"]

    return {"support": supports, "resistance": resistances}

def merge_close_zones(zones, min_gap_pct):
    if min_gap_pct <= 0:
        return zones

    def merge_list(items):
        if not items:
            return items
        items = sorted(items, key=lambda x: x["price"])
        merged = [items[0]]
        for item in items[1:]:
            last = merged[-1]
            gap = abs(item["price"] - last["price"])
            min_gap = last["price"] * (min_gap_pct / 100.0)
            if gap <= min_gap:
                # Unisci media dei prezzi e aggiorna range
                new_price = round((last["price"] + item["price"]) / 2, 2)
                merged[-1] = {
                    "price": new_price,
                    "min": round(min(last["min"], item["min"]), 2),
                    "max": round(max(last["max"], item["max"]), 2),
                }
            else:
                merged.append(item)
        return merged

    return {
        "support": merge_list(zones["support"]),
        "resistance": merge_list(zones["resistance"]),
    }

# ---------------------- Flask Endpoint ----------------------
@app.route("/stock/<ticker>/live_price")
def get_live_price(ticker):
    raw_ticker = ticker
    try:
        price = None
        stock = None
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            price = None

            # Tentativo rapido con fast_info
            try:
                fast = getattr(stock, "fast_info", None)
                if fast:
                    if isinstance(fast, dict):
                        for key in ("last_price", "lastPrice", "regularMarketPrice", "regular_market_price", "last"):
                            if key in fast and fast[key] is not None:
                                price = fast[key]
                                break
                    else:
                        if hasattr(fast, "last_price") and fast.last_price is not None:
                            price = fast.last_price
                        elif hasattr(fast, "lastPrice") and fast.lastPrice is not None:
                            price = fast.lastPrice
            except Exception:
                pass

            # Fallback intraday 1m
            if price is None:
                intraday = safe_history(stock, period="1d", interval="1m")
                if not intraday.empty:
                    price = float(intraday["Close"].iloc[-1])

            # Fallback giornaliero
            if price is None:
                daily = safe_history(stock, period="2d", interval="1d")
                if not daily.empty:
                    price = float(daily["Close"].iloc[-1])

            if price is not None:
                ticker = cand
                break

        if price is None:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        return jsonify({
            "ticker": ticker.upper(),
            "current_price": round(float(price), 2),
            "last_update": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        })

    except Exception as e:
        print(f"[ERROR] Live price {ticker}: {e}")
        return jsonify({"error": "Errore nel recupero del prezzo"}), 500

@app.route("/stock/<ticker>/supply_demand")
def get_supply_demand(ticker):
    raw_ticker = ticker
    now = datetime.utcnow()
    timeframe = request.args.get("timeframe", "1d")
    yf_interval = TF_MAPPING.get(timeframe, "1d")
    strength_override = request.args.get("strength")
    min_pct_override = request.args.get("min_pct")
    gap_pct_override = request.args.get("gap_pct")

    if yf_interval == "1d":
        period = "6mo"
        chart_range = "1y"
    elif yf_interval == "1wk":
        period = "5y"
        chart_range = "5y"
    elif yf_interval == "1mo":
        period = "20y"
        chart_range = "20y"
    else:
        period = "3mo"
        chart_range = "6mo"

    candidates = ticker_candidates(raw_ticker)
    for cand in candidates:
        cache_key = f"{cand.upper()}:{timeframe}:{strength_override}:{min_pct_override}:{gap_pct_override}"
        cached = _cache_get(supply_demand_cache, cache_key, SUPPLY_DEMAND_CACHE_TTL)
        if cached is not None:
            return jsonify(cached)

    try:
        hist = pd.DataFrame()
        stock = None
        for cand in candidates:
            stock = yf.Ticker(cand)
            hist = _fetch_interval_history(cand, stock, period, yf_interval, chart_range)
            if not hist.empty:
                ticker = cand
                break
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        # Normalizzazione minima per evitare KeyError su colonne mancanti
        for col in ("Open", "High", "Low", "Close"):
            if col not in hist.columns:
                hist[col] = np.nan
        if "Volume" not in hist.columns:
            hist["Volume"] = 0.0
        hist["Close"] = pd.to_numeric(hist["Close"], errors="coerce")
        hist["Low"] = pd.to_numeric(hist["Low"], errors="coerce").fillna(hist["Close"])
        hist["High"] = pd.to_numeric(hist["High"], errors="coerce").fillna(hist["Close"])
        hist["Volume"] = pd.to_numeric(hist["Volume"], errors="coerce").fillna(0.0)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        # Allinea le zone al grafico (ultimi N punti per timeframe)
        tail_map = {"1d": 120, "1w": 100, "1mo": 60}
        hist = hist.tail(tail_map.get(timeframe, 120))

        strength_map = {"1d": 70, "1w": 80, "1mo": 90}
        pivot_source = "hilo" if timeframe in ("1w", "1mo") else "close"
        strength = strength_map.get(timeframe, 75)
        if strength_override is not None:
            try:
                strength = float(strength_override)
            except ValueError:
                strength = strength_map.get(timeframe, 75)

        zones = calculate_supply_demand_zones(
            hist,
            strength_percentile=strength,
            pivot_source=pivot_source
        )
        current_price = round(float(hist['Close'].iloc[-1]), 2)
        min_pct_map = {"1d": 1.0, "1w": 2.0, "1mo": 4.0}
        min_pct = min_pct_map.get(timeframe, 1.0)
        if min_pct_override is not None:
            try:
                min_pct = float(min_pct_override)
            except ValueError:
                min_pct = min_pct_map.get(timeframe, 1.0)
        zones = filter_zones_by_distance(zones, current_price, min_pct)
        gap_map = {"1d": 0.6, "1w": 1.2, "1mo": 2.5}
        gap_pct = gap_map.get(timeframe, 0.6)
        if gap_pct_override is not None:
            try:
                gap_pct = float(gap_pct_override)
            except ValueError:
                gap_pct = gap_map.get(timeframe, 0.6)
        zones = merge_close_zones(zones, gap_pct)
        market_state = determine_market_state(current_price, zones['support'], zones['resistance'])

        response = {
            "ticker": ticker.upper(),
            "current_price": current_price,
            "zones": zones,
            "market_state": market_state,
            "last_update": now.strftime("%Y-%m-%d %H:%M:%S")
        }

        # Salva in cache
        cache_key = f"{ticker.upper()}:{timeframe}:{strength_override}:{min_pct_override}:{gap_pct_override}"
        _cache_set(supply_demand_cache, cache_key, response, max_size=320)

        return jsonify(response)

    except Exception as e:
        print(f"[ERROR] Supply/Demand {ticker}: {e}")
        return jsonify({"error": "Errore nel calcolo delle zone"}), 500

@app.route("/stock/<ticker>/history")
def get_stock_history(ticker):
    raw_ticker = ticker
    timeframe = request.args.get("timeframe", "1d")
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"{cache_symbol}:{timeframe}"
    cached = _cache_get(history_cache, cache_key, HISTORY_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        yf_interval = TF_MAPPING.get(timeframe, "1d")

        if yf_interval == "1d":
            period = "6mo"
            chart_range = "1y"
        elif yf_interval == "1wk":
            period = "5y"
            chart_range = "5y"
        elif yf_interval == "1mo":
            period = "20y"
            chart_range = "20y"
        else:
            period = "3mo"
            chart_range = "6mo"

        date_fmt = "%Y-%m" if yf_interval == "1mo" else "%Y-%m-%d"

        tail_map = {"1d": 120, "1w": 120, "1mo": 120}
        tail_limit = tail_map.get(timeframe, 120)

        hist = pd.DataFrame()
        stock = None
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            hist = _fetch_interval_history(cand, stock, period, yf_interval, chart_range)
            hist = hist.tail(tail_limit)
            if not hist.empty:
                ticker = cand
                break
        if hist.empty:
            payload = {"history": []}
            _cache_set(history_cache, cache_key, payload, max_size=320)
            return jsonify(payload)

        for col in ("Open", "High", "Low", "Close"):
            if col not in hist.columns:
                hist[col] = np.nan
        hist["Open"] = pd.to_numeric(hist["Open"], errors="coerce")
        hist["High"] = pd.to_numeric(hist["High"], errors="coerce")
        hist["Low"] = pd.to_numeric(hist["Low"], errors="coerce")
        hist["Close"] = pd.to_numeric(hist["Close"], errors="coerce")
        hist = hist.dropna(subset=["Open", "High", "Low", "Close"])
        if hist.empty:
            payload = {"history": []}
            _cache_set(history_cache, cache_key, payload, max_size=320)
            return jsonify(payload)

        history_data = [
            {
                "date": date.strftime(date_fmt),
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "close": round(float(row["Close"]), 2),
            }
            for date, row in hist.iterrows()
        ]
        payload = {"history": history_data}
        _cache_set(history_cache, cache_key, payload, max_size=320)
        return jsonify(payload)
    except Exception as e:
        print("Errore storico:", e)
        return jsonify({"history": []}), 500





    

if __name__ == "__main__":
    debug_env = os.environ.get("FLASK_DEBUG")
    debug_enabled = (
        debug_env.lower() in {"1", "true", "yes", "on"} if debug_env is not None else True
    )
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=debug_enabled)




