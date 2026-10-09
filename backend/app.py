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
import hashlib
import sqlite3
import time
from threading import Lock
from functools import lru_cache, wraps
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from ml.market_tls import configure_market_tls
except ImportError:
    from backend.ml.market_tls import configure_market_tls
configure_market_tls(os.path.join(os.path.dirname(__file__), ".yf-cache"))

try:
    from ml.fundamental_model import build_feature_vector, predict_from_artifact
    from ml.quantitative_advanced import build_quantitative_research_payload
    from ml.heatmap_signal import build_heatmap_signal, unavailable_signal, VERSION as HEATMAP_SIGNAL_VERSION
    from ml.analysis_pages import completed_daily_history, technical_page_payload, seasonality_page_payload, PAGE_ENGINE_VERSION
    from ml.page_structure import calculate_supply_demand_zones, determine_market_state, filter_zones_by_distance, merge_close_zones
    from ml.structure_neural import build_structure_neural, VERSION as STRUCTURE_NEURAL_VERSION, validate_request as validate_neural_request
    from ml.point_in_time import (
        V5_CATEGORICAL_FEATURE_NAMES,
        V5_MARKET_FEATURE_NAMES,
        V5_MARKET_MISSING_FLAG_NAMES,
        build_market_event_features,
        build_filing_index as build_ml_filing_index,
        extract_annual_vintages as extract_ml_annual_vintages,
        extract_filing_vintages as extract_ml_filing_vintages,
        latest_usable_vintage as latest_ml_usable_vintage,
        resolve_security_point_in_time,
    )
except ImportError:  # Supporta anche ``import backend.app`` dalla root.
    from backend.ml.fundamental_model import build_feature_vector, predict_from_artifact
    from backend.ml.quantitative_advanced import build_quantitative_research_payload
    from backend.ml.heatmap_signal import build_heatmap_signal, unavailable_signal, VERSION as HEATMAP_SIGNAL_VERSION
    from backend.ml.analysis_pages import completed_daily_history, technical_page_payload, seasonality_page_payload, PAGE_ENGINE_VERSION
    from backend.ml.page_structure import calculate_supply_demand_zones, determine_market_state, filter_zones_by_distance, merge_close_zones
    from backend.ml.structure_neural import build_structure_neural, VERSION as STRUCTURE_NEURAL_VERSION, validate_request as validate_neural_request
    from backend.ml.point_in_time import (
        V5_CATEGORICAL_FEATURE_NAMES,
        V5_MARKET_FEATURE_NAMES,
        V5_MARKET_MISSING_FLAG_NAMES,
        build_market_event_features,
        build_filing_index as build_ml_filing_index,
        extract_annual_vintages as extract_ml_annual_vintages,
        extract_filing_vintages as extract_ml_filing_vintages,
        latest_usable_vintage as latest_ml_usable_vintage,
        resolve_security_point_in_time,
    )

try:
    from yfinance import const as yf_const
except Exception:
    yf_const = None


YFINANCE_CACHE_DIR = (
    os.environ.get("YFINANCE_CACHE_DIR")
    or os.path.join(os.path.dirname(__file__), ".yf-cache")
)
try:
    os.makedirs(YFINANCE_CACHE_DIR, exist_ok=True)
    if hasattr(yf, "set_tz_cache_location"):
        yf.set_tz_cache_location(YFINANCE_CACHE_DIR)
except OSError:
    # Il fallback HTTP diretto resta disponibile anche senza cache persistente.
    pass




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


@app.route("/health")
def healthcheck():
    """Endpoint leggero usato dall'hosting per controllare il servizio."""
    return jsonify({"status": "ok"}), 200

# Cache rapido per endpoint /stock
stock_response_cache = {}
STOCK_CACHE_TTL = timedelta(seconds=120)
PRICE_ONLY_CACHE_TTL = timedelta(seconds=10)

# Cache endpoint pesanti
technicals_cache = {}
partial_corr_cache = {}
heatmap_relations_cache = {}
page_daily_history_cache = {}
structure_neural_cache = {}
structure_neural_lock = Lock()
heatmap_prices_cache = {}
seasonality_cache = {}
history_cache = {}
supply_demand_cache = {}
search_suggestions_cache = {}
financials_cache = {}
sec_reference_cache = {}
sec_companyfacts_cache = {}
sec_filings_cache = {}
sec_submissions_cache = {}
fundamental_forecast_cache = {}
quantitative_research_cache = {}

TECHNICALS_CACHE_TTL = timedelta(minutes=4)
PARTIAL_CORR_CACHE_TTL = timedelta(minutes=12)
SEASONALITY_CACHE_TTL = timedelta(minutes=20)
HISTORY_CACHE_TTL = timedelta(seconds=120)
SUPPLY_DEMAND_CACHE_TTL = timedelta(minutes=6)
SEARCH_SUGGESTIONS_CACHE_TTL = timedelta(minutes=5)
TRADINGVIEW_HEATMAP_CACHE_TTL = timedelta(minutes=3)
HEATMAP_RELATIONS_CACHE_TTL = timedelta(minutes=15)
FINANCIALS_CACHE_TTL = timedelta(minutes=30)
SEC_REFERENCE_CACHE_TTL = timedelta(hours=24)
SEC_COMPANYFACTS_CACHE_TTL = timedelta(hours=6)
SEC_FILINGS_CACHE_TTL = timedelta(hours=1)
SEC_NEGATIVE_CACHE_TTL = timedelta(minutes=2)
FUNDAMENTAL_FORECAST_CACHE_TTL = timedelta(minutes=30)
QUANTITATIVE_RESEARCH_CACHE_TTL = timedelta(minutes=30)
FUNDAMENTAL_MODEL_PATH = (
    os.environ.get("FUNDAMENTAL_MODEL_PATH")
    or os.path.join(
        os.path.dirname(__file__),
        "models",
        "fundamental_return_model.json",
    )
)
FUNDAMENTAL_TRAINING_CACHE_DIR = (
    os.environ.get("FUNDAMENTAL_TRAINING_CACHE_DIR")
    or os.path.join(os.path.dirname(__file__), ".ml-cache")
)
_fundamental_model_state = {
    "path": None,
    "mtime": None,
    "artifact": None,
}

FINANCIAL_STATEMENT_CONFIG = {
    "income": {
        "label": "Conto economico",
        "includeTtm": True,
        "rows": [
            {"key": "TotalRevenue", "label": "Ricavi totali"},
            {"key": "CostOfRevenue", "label": "Costo dei ricavi", "detail": True},
            {"key": "GrossProfit", "label": "Utile lordo"},
            {"key": "OperatingExpense", "label": "Spese operative"},
            {
                "key": "SellingGeneralAndAdministration",
                "label": "Spese generali e amministrative",
                "detail": True,
            },
            {
                "key": "ResearchAndDevelopment",
                "label": "Ricerca e sviluppo",
                "detail": True,
            },
            {"key": "OperatingIncome", "label": "Utile operativo"},
            {
                "key": "NetNonOperatingInterestIncomeExpense",
                "label": "Proventi/oneri finanziari netti",
                "detail": True,
            },
            {"key": "OtherIncomeExpense", "label": "Altri proventi/oneri", "detail": True},
            {"key": "PretaxIncome", "label": "Utile prima delle imposte"},
            {"key": "TaxProvision", "label": "Imposte sul reddito", "detail": True},
            {"key": "NetIncomeCommonStockholders", "label": "Utile netto agli azionisti"},
            {
                "key": "DilutedNIAvailtoComStockholders",
                "label": "Utile netto diluito disponibile",
                "detail": True,
            },
            {"key": "BasicEPS", "label": "EPS base", "format": "perShare"},
            {"key": "DilutedEPS", "label": "EPS diluito", "format": "perShare"},
            {
                "key": "BasicAverageShares",
                "label": "Numero medio azioni base",
                "detail": True,
            },
            {
                "key": "DilutedAverageShares",
                "label": "Numero medio azioni diluite",
                "detail": True,
            },
            {
                "key": "TotalOperatingIncomeAsReported",
                "label": "Utile operativo dichiarato",
                "detail": True,
            },
            {"key": "TotalExpenses", "label": "Spese totali", "detail": True},
            {"key": "NormalizedIncome", "label": "Utile normalizzato", "detail": True},
            {"key": "InterestIncome", "label": "Interessi attivi", "detail": True},
            {"key": "InterestExpense", "label": "Interessi passivi", "detail": True},
            {"key": "NetInterestIncome", "label": "Interessi netti", "detail": True},
            {"key": "EBIT", "label": "EBIT"},
            {"key": "EBITDA", "label": "EBITDA"},
        ],
    },
    "balance": {
        "label": "Stato patrimoniale",
        "includeTtm": False,
        "rows": [
            {"key": "TotalAssets", "label": "Totale attività"},
            {"key": "CurrentAssets", "label": "Attività correnti"},
            {
                "key": "CashCashEquivalentsAndShortTermInvestments",
                "label": "Liquidità e investimenti a breve",
                "detail": True,
            },
            {
                "key": "CashAndCashEquivalents",
                "label": "Disponibilità liquide",
                "detail": True,
            },
            {"key": "AccountsReceivable", "label": "Crediti commerciali", "detail": True},
            {"key": "Inventory", "label": "Rimanenze", "detail": True},
            {"key": "TotalNonCurrentAssets", "label": "Attività non correnti"},
            {"key": "NetPPE", "label": "Immobili, impianti e macchinari", "detail": True},
            {
                "key": "GoodwillAndOtherIntangibleAssets",
                "label": "Avviamento e attività immateriali",
                "detail": True,
            },
            {
                "key": "TotalLiabilitiesNetMinorityInterest",
                "label": "Totale passività",
            },
            {"key": "CurrentLiabilities", "label": "Passività correnti"},
            {"key": "AccountsPayable", "label": "Debiti commerciali", "detail": True},
            {"key": "CurrentDebt", "label": "Debito corrente", "detail": True},
            {
                "key": "TotalNonCurrentLiabilitiesNetMinorityInterest",
                "label": "Passività non correnti",
            },
            {"key": "LongTermDebt", "label": "Debito a lungo termine", "detail": True},
            {"key": "TotalDebt", "label": "Debito totale"},
            {"key": "NetDebt", "label": "Debito netto", "detail": True},
            {"key": "StockholdersEquity", "label": "Patrimonio netto"},
            {
                "key": "TotalEquityGrossMinorityInterest",
                "label": "Patrimonio netto incluse minoranze",
                "detail": True,
            },
            {"key": "WorkingCapital", "label": "Capitale circolante", "detail": True},
            {"key": "InvestedCapital", "label": "Capitale investito", "detail": True},
            {"key": "TangibleBookValue", "label": "Valore contabile tangibile", "detail": True},
            {
                "key": "OrdinarySharesNumber",
                "label": "Numero azioni ordinarie",
                "detail": True,
            },
        ],
    },
    "cash": {
        "label": "Flussi di cassa",
        "includeTtm": True,
        "rows": [
            {"key": "OperatingCashFlow", "label": "Flusso di cassa operativo"},
            {"key": "InvestingCashFlow", "label": "Flusso di cassa da investimenti"},
            {"key": "FinancingCashFlow", "label": "Flusso di cassa da finanziamenti"},
            {"key": "EndCashPosition", "label": "Liquidità finale"},
            {
                "key": "IncomeTaxPaidSupplementalData",
                "label": "Imposte pagate",
                "detail": True,
            },
            {
                "key": "InterestPaidSupplementalData",
                "label": "Interessi pagati",
                "detail": True,
            },
            {"key": "CapitalExpenditure", "label": "Spese in conto capitale"},
            {
                "key": "PurchaseOfBusiness",
                "label": "Acquisizioni di aziende",
                "detail": True,
            },
            {"key": "IssuanceOfDebt", "label": "Emissione di debito", "detail": True},
            {"key": "RepaymentOfDebt", "label": "Rimborso del debito", "detail": True},
            {
                "key": "IssuanceOfCapitalStock",
                "label": "Emissione di capitale",
                "detail": True,
            },
            {
                "key": "RepurchaseOfCapitalStock",
                "label": "Riacquisto di azioni",
                "detail": True,
            },
            {"key": "CashDividendsPaid", "label": "Dividendi pagati", "detail": True},
            {
                "key": "ChangeInWorkingCapital",
                "label": "Variazione capitale circolante",
                "detail": True,
            },
            {"key": "ChangeInInventory", "label": "Variazione rimanenze", "detail": True},
            {
                "key": "ChangeInReceivables",
                "label": "Variazione crediti",
                "detail": True,
            },
            {"key": "ChangeInPayable", "label": "Variazione debiti", "detail": True},
            {
                "key": "StockBasedCompensation",
                "label": "Compensi basati su azioni",
                "detail": True,
            },
            {
                "key": "DepreciationAndAmortization",
                "label": "Ammortamenti e svalutazioni",
                "detail": True,
            },
            {
                "key": "NetIncomeFromContinuingOperations",
                "label": "Utile netto da attività continuative",
                "detail": True,
            },
            {"key": "FreeCashFlow", "label": "Free cash flow"},
        ],
    },
}

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


def _cache_get_adaptive(
    cache_dict,
    key,
    positive_ttl,
    *,
    is_negative=None,
    negative_ttl=SEC_NEGATIVE_CACHE_TTL,
):
    """Usa una TTL breve per gli errori temporanei memorizzati in cache.

    Le sorgenti SEC possono fallire per timeout o rate limit. Conservare un
    payload vuoto per ore rende un ticker esistente artificialmente
    indisponibile anche dopo il ripristino della sorgente.
    """

    entry = cache_dict.get(key)
    if not entry:
        return None
    payload = entry[0]
    predicate = is_negative or (lambda value: not value)
    ttl = negative_ttl if predicate(payload) else positive_ttl
    return _cache_get(cache_dict, key, ttl)

def _cache_set(cache_dict, key, payload, max_size=300):
    cache_dict[key] = (payload, datetime.utcnow())
    # Bound memory: rimuove la chiave più vecchia quando supera soglia
    if len(cache_dict) > max_size:
        try:
            oldest_key = min(cache_dict, key=lambda k: cache_dict[k][1])
            del cache_dict[oldest_key]
        except Exception:
            pass


def _json_safe(value):
    """Converte ricorsivamente i tipi numerici in JSON RFC-compliant."""
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.floating, float)):
        numeric = float(value)
        return numeric if np.isfinite(numeric) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


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
        kwargs.setdefault("timeout", 8)
        return stock.history(*args, **kwargs)
    except Exception:
        return pd.DataFrame()

def safe_download(*args, **kwargs):
    try:
        kwargs.setdefault("timeout", 8)
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


def _resample_ohlc_by_bar_count(df, bars_per_bucket=4):
    """Aggrega barre intraday senza mescolare sedute di borsa differenti."""
    source = _prepare_ohlc_df(df, require_complete=True)
    if source.empty or not isinstance(source.index, pd.DatetimeIndex):
        return pd.DataFrame()

    frames = []
    for _, session in source.groupby(source.index.normalize(), sort=True):
        session = session.sort_index()
        bucket = pd.Series(
            np.arange(len(session), dtype="int64") // max(int(bars_per_bucket), 1),
            index=session.index,
        )
        grouped = session.groupby(bucket).agg(
            {
                "Open": "first",
                "High": "max",
                "Low": "min",
                "Close": "last",
                "Volume": "sum",
            }
        )
        grouped.index = [
            session.index[min(int(group_id) * bars_per_bucket, len(session) - 1)]
            for group_id in grouped.index
        ]
        frames.append(grouped)

    if not frames:
        return pd.DataFrame()
    return _prepare_ohlc_df(pd.concat(frames).sort_index(), require_complete=True)


def _normalize_ohlc_df(df):
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return pd.DataFrame()
    inherited_invalid_rows = 0
    try:
        inherited_invalid_rows = max(
            int(df.attrs.get("invalidRowsRemoved", 0)),
            0,
        )
    except (TypeError, ValueError):
        inherited_invalid_rows = 0
    out = df.copy()
    original_row_count = len(out)
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
    for col in (
        "Open",
        "High",
        "Low",
        "Close",
        "Adj Close",
        "Volume",
        "Dividends",
        "Stock Splits",
    ):
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.replace([np.inf, -np.inf], np.nan)
    if "Close" in out.columns:
        out = out.dropna(subset=["Close"])
    out = out.sort_index()
    out.attrs["invalidRowsRemoved"] = (
        inherited_invalid_rows + max(original_row_count - len(out), 0)
    )
    return out


def _prepare_ohlc_df(df, require_complete=True):
    """Normalizza OHLC e impedisce che NaN/Infinity arrivino al JSON."""
    out = _normalize_ohlc_df(df)
    if out.empty:
        return pd.DataFrame()
    inherited_invalid_rows = int(out.attrs.get("invalidRowsRemoved", 0) or 0)
    original_row_count = len(out)

    for col in ("Open", "High", "Low", "Close"):
        if col not in out.columns:
            out[col] = np.nan
        out[col] = pd.to_numeric(out[col], errors="coerce")
    if "Volume" not in out.columns:
        out["Volume"] = 0.0
    out["Volume"] = pd.to_numeric(out["Volume"], errors="coerce").fillna(0.0)
    for column in ("Dividends", "Stock Splits"):
        if column not in out.columns:
            out[column] = 0.0
        out[column] = pd.to_numeric(out[column], errors="coerce").fillna(0.0)
    out = out.replace([np.inf, -np.inf], np.nan)
    out[["Volume", "Dividends", "Stock Splits"]] = out[
        ["Volume", "Dividends", "Stock Splits"]
    ].fillna(0.0)

    required = ["Open", "High", "Low", "Close"] if require_complete else ["Close"]
    out = out.dropna(subset=required).sort_index()
    out.attrs["invalidRowsRemoved"] = (
        inherited_invalid_rows + max(original_row_count - len(out), 0)
    )
    return out


def _valid_market_number(value, allow_zero=False):
    if isinstance(value, dict):
        value = value.get("raw")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    if number < 0 or (number == 0 and not allow_zero):
        return None
    return number


def _market_timestamp_from_meta(meta):
    raw_timestamp = _valid_market_number(
        (meta or {}).get("regularMarketTime"),
        allow_zero=False,
    )
    if raw_timestamp is None:
        return None

    timestamp = pd.to_datetime(raw_timestamp, unit="s", utc=True, errors="coerce")
    if pd.isna(timestamp):
        return None

    exchange_timezone = (meta or {}).get("exchangeTimezoneName")
    if exchange_timezone:
        try:
            timestamp = timestamp.tz_convert(exchange_timezone)
        except Exception:
            pass
    try:
        return timestamp.tz_localize(None)
    except TypeError:
        return timestamp


def _market_state_from_meta(meta):
    state = str((meta or {}).get("marketState") or "").strip().upper()
    if state:
        return state

    now_epoch = datetime.now(timezone.utc).timestamp()
    periods = (meta or {}).get("currentTradingPeriod") or {}
    for key, label in (("regular", "REGULAR"), ("pre", "PRE"), ("post", "POST")):
        period = periods.get(key) or {}
        start = _valid_market_number(period.get("start"), allow_zero=False)
        end = _valid_market_number(period.get("end"), allow_zero=False)
        if start is not None and end is not None and start <= now_epoch <= end:
            return label
    return "CLOSED" if periods else "UNKNOWN"


def _market_snapshot_frame(meta):
    meta = meta or {}
    price = _valid_market_number(meta.get("regularMarketPrice"))
    timestamp = _market_timestamp_from_meta(meta)
    if price is None or timestamp is None:
        return pd.DataFrame()

    open_price = _valid_market_number(meta.get("regularMarketOpen")) or price
    high_price = _valid_market_number(meta.get("regularMarketDayHigh")) or price
    low_price = _valid_market_number(meta.get("regularMarketDayLow")) or price
    high_price = max(high_price, open_price, price)
    low_price = min(low_price, open_price, price)
    volume = _valid_market_number(
        meta.get("regularMarketVolume"),
        allow_zero=True,
    )

    return pd.DataFrame(
        {
            "Open": [open_price],
            "High": [high_price],
            "Low": [low_price],
            "Close": [price],
            "Volume": [volume if volume is not None else 0.0],
        },
        index=pd.DatetimeIndex([timestamp]),
    )


def _merge_daily_market_data(*frames):
    """Unisce fonti giornaliere scegliendo l'ultima versione valida per seduta."""
    prepared_frames = []
    for frame in frames:
        prepared = _prepare_ohlc_df(frame, require_complete=False)
        if prepared.empty or not isinstance(prepared.index, pd.DatetimeIndex):
            continue
        prepared = prepared.copy()
        for column in ("Open", "High", "Low"):
            prepared[column] = prepared[column].fillna(prepared["Close"])
        prepared["Volume"] = prepared["Volume"].fillna(0.0)
        prepared.index = prepared.index.normalize()
        prepared_frames.append(prepared[["Open", "High", "Low", "Close", "Volume"]])

    if not prepared_frames:
        return pd.DataFrame()

    combined = pd.concat(prepared_frames, axis=0, sort=False)
    combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    return _prepare_ohlc_df(combined, require_complete=True)


def _fetch_latest_daily_market_data(ticker, base_daily_data):
    """Completa lo storico corto con l'ultima seduta indicata dai metadata Yahoo."""
    chart_daily, chart_meta = _fetch_chart_data(ticker, "1mo", "1d")
    snapshot = _market_snapshot_frame(chart_meta)
    merged = _merge_daily_market_data(base_daily_data, chart_daily, snapshot)
    if merged.empty:
        merged = _merge_daily_market_data(base_daily_data)
    return merged, chart_meta or {}


def _price_metadata(daily_data, chart_meta):
    prepared = _prepare_ohlc_df(daily_data, require_complete=True)
    if prepared.empty:
        return {
            "currentPrice": None,
            "previousClose": None,
            "dailyLow": None,
            "dailyHigh": None,
            "dailyOpen": None,
            "dailyChange": None,
            "priceDate": None,
            "priceTimestamp": None,
            "priceSource": None,
            "marketState": _market_state_from_meta(chart_meta),
        }

    latest = prepared.iloc[-1]
    latest_date = pd.Timestamp(prepared.index[-1]).strftime("%Y-%m-%d")
    previous_close = (
        _valid_market_number(prepared["Close"].iloc[-2])
        if len(prepared) >= 2
        else None
    )
    current_price = _valid_market_number(latest.get("Close"))
    daily_change = None
    if current_price is not None and previous_close is not None:
        daily_change = round(
            ((current_price - previous_close) / previous_close) * 100,
            2,
        )

    meta_timestamp = _market_timestamp_from_meta(chart_meta)
    meta_date = meta_timestamp.strftime("%Y-%m-%d") if meta_timestamp is not None else None
    market_price = _valid_market_number((chart_meta or {}).get("regularMarketPrice"))
    uses_market_snapshot = (
        meta_date == latest_date
        and market_price is not None
        and current_price is not None
        and np.isclose(market_price, current_price, rtol=1e-9, atol=1e-9)
    )
    timestamp_iso = None
    if uses_market_snapshot:
        raw_timestamp = _valid_market_number(
            (chart_meta or {}).get("regularMarketTime"),
            allow_zero=False,
        )
        if raw_timestamp is not None:
            timestamp_iso = (
                datetime.fromtimestamp(raw_timestamp, tz=timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            )

    return {
        "currentPrice": current_price,
        "previousClose": previous_close,
        "dailyLow": _valid_market_number(latest.get("Low")),
        "dailyHigh": _valid_market_number(latest.get("High")),
        "dailyOpen": _valid_market_number(latest.get("Open")),
        "dailyChange": daily_change,
        "priceDate": latest_date,
        "priceTimestamp": timestamp_iso or latest_date,
        "priceSource": "market" if uses_market_snapshot else "history",
        "marketState": _market_state_from_meta(chart_meta),
    }


def _fetch_interval_history(cand, stock, period, interval, chart_range):
    requested_interval = interval
    provider_interval = "60m" if requested_interval == "240m" else requested_interval
    hist = _normalize_ohlc_df(
        safe_history(
            stock,
            period=period,
            interval=provider_interval,
            auto_adjust=False,
            actions=True,
        )
    )
    if hist.empty:
        hist = _normalize_ohlc_df(
            safe_download(
                cand,
                period=period,
                interval=provider_interval,
                auto_adjust=False,
                actions=True,
                progress=False,
                threads=False,
            )
        )

    # Per weekly/monthly preferisci ricostruzione da daily: è più stabile e precisa
    # quando Yahoo limita il numero di punti per interval=1wk/1mo.
    if hist.empty and requested_interval in ("1wk", "1mo"):
        daily = _normalize_ohlc_df(
            safe_history(
                stock,
                period=period,
                interval="1d",
                auto_adjust=False,
                actions=True,
            )
        )
        if daily.empty:
            daily = _normalize_ohlc_df(
                safe_download(
                    cand,
                    period=period,
                    interval="1d",
                    auto_adjust=False,
                    actions=True,
                    progress=False,
                    threads=False,
                )
            )
        if daily.empty:
            daily, _ = _fetch_chart_data(cand, chart_range, "1d")
            daily = _normalize_ohlc_df(daily)
        if not daily.empty:
            rule = "W-FRI" if requested_interval == "1wk" else "ME"
            hist = _resample_ohlc(daily, rule)

    if hist.empty:
        hist, _ = _fetch_chart_data(cand, chart_range, provider_interval)
        hist = _normalize_ohlc_df(hist)

    if requested_interval == "240m" and not hist.empty:
        hist = _resample_ohlc_by_bar_count(hist, bars_per_bucket=4)

    return hist

def _fetch_chart_data(ticker, range_str="5d", interval="1d", auto_adjust=False):
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

    def quote_series(key):
        values = q0.get(key)
        if not isinstance(values, list) or len(values) != len(timestamps):
            values = [np.nan] * len(timestamps)
        return pd.Series(values, dtype="float64")

    close_values = quote_series("close")
    open_values = quote_series("open")
    high_values = quote_series("high")
    low_values = quote_series("low")
    volume_values = quote_series("volume")
    adj_groups = r0.get("indicators", {}).get("adjclose", [])
    adjusted_values = (
        pd.Series(adj_groups[0].get("adjclose"), dtype="float64")
        if adj_groups
        and isinstance(adj_groups[0], dict)
        and isinstance(adj_groups[0].get("adjclose"), list)
        else pd.Series(np.nan, index=range(len(timestamps)), dtype="float64")
    )
    if len(adjusted_values) != len(close_values):
        adjusted_values = pd.Series(
            np.nan,
            index=range(len(timestamps)),
            dtype="float64",
        )

    if auto_adjust and adjusted_values.notna().any():
        if len(adjusted_values) == len(close_values):
            effective_adjusted_values = adjusted_values.combine_first(close_values)
            factor = effective_adjusted_values / close_values.replace(0, np.nan)
            open_values = open_values * factor
            high_values = high_values * factor
            low_values = low_values * factor
            close_values = effective_adjusted_values

    timestamp_positions = {}
    normalized_date_positions = {}
    for position, raw_timestamp in enumerate(timestamps):
        try:
            numeric_timestamp = int(raw_timestamp)
        except (TypeError, ValueError):
            continue
        timestamp_positions.setdefault(numeric_timestamp, position)
        normalized_date = pd.Timestamp(numeric_timestamp, unit="s").normalize()
        normalized_date_positions.setdefault(normalized_date, position)

    def event_position(event_key, event):
        event_data = event if isinstance(event, dict) else {}
        raw_timestamp = event_data.get("date", event_key)
        try:
            numeric_timestamp = int(raw_timestamp)
        except (TypeError, ValueError):
            return None
        exact_position = timestamp_positions.get(numeric_timestamp)
        if exact_position is not None:
            return exact_position
        return normalized_date_positions.get(
            pd.Timestamp(numeric_timestamp, unit="s").normalize()
        )

    dividends = np.zeros(len(timestamps), dtype="float64")
    stock_splits = np.zeros(len(timestamps), dtype="float64")
    events = r0.get("events") or {}
    dividend_events = events.get("dividends") or {}
    if isinstance(dividend_events, dict):
        for event_key, event in dividend_events.items():
            position = event_position(event_key, event)
            event_data = event if isinstance(event, dict) else {}
            amount = _financial_number(event_data.get("amount"))
            if position is not None and amount is not None:
                dividends[position] += amount

    split_events = events.get("splits") or {}
    if isinstance(split_events, dict):
        for event_key, event in split_events.items():
            position = event_position(event_key, event)
            event_data = event if isinstance(event, dict) else {}
            numerator = _financial_number(event_data.get("numerator"))
            denominator = _financial_number(event_data.get("denominator"))
            split_ratio = None
            if numerator is not None and denominator not in (None, 0):
                split_ratio = numerator / denominator
            if split_ratio is None:
                ratio_text = str(event_data.get("splitRatio") or "")
                ratio_parts = ratio_text.split(":", 1)
                if len(ratio_parts) == 2:
                    ratio_numerator = _financial_number(ratio_parts[0])
                    ratio_denominator = _financial_number(ratio_parts[1])
                    if ratio_numerator is not None and ratio_denominator not in (None, 0):
                        split_ratio = ratio_numerator / ratio_denominator
            if position is not None and split_ratio is not None:
                stock_splits[position] = (
                    split_ratio
                    if stock_splits[position] == 0
                    else stock_splits[position] * split_ratio
                )

    df = pd.DataFrame(
        {
            "Open": open_values.to_numpy(),
            "High": high_values.to_numpy(),
            "Low": low_values.to_numpy(),
            "Close": close_values.to_numpy(),
            "Adj Close": adjusted_values.to_numpy(),
            "Volume": volume_values.to_numpy(),
            "Dividends": dividends,
            "Stock Splits": stock_splits,
        },
        index=pd.to_datetime(timestamps, unit="s"),
    )
    original_row_count = len(df)
    df = df.dropna(subset=["Close"])
    df.attrs["invalidRowsRemoved"] = max(original_row_count - len(df), 0)
    # Preserve the source timestamp convention for consumers needing local
    # session dates (FX midnight London is the previous UTC date in summer).
    df.attrs["timestampTimezone"] = "UTC"
    df.attrs["exchangeTimezoneName"] = (r0.get("meta") or {}).get("exchangeTimezoneName")
    return df, r0.get("meta", {}) or {}


def _fetch_analytics_history(ticker, stock, period="6y", auto_adjust=True):
    history = _normalize_ohlc_df(
        safe_history(
            stock,
            period=period,
            interval="1d",
            auto_adjust=auto_adjust,
        )
    )
    if history.empty:
        history = _normalize_ohlc_df(
            safe_download(
                ticker,
                period=period,
                interval="1d",
                auto_adjust=auto_adjust,
                progress=False,
                threads=False,
            )
        )
    if history.empty:
        history, _ = _fetch_chart_data(
            ticker,
            "10y",
            "1d",
            auto_adjust=auto_adjust,
        )
        history = _normalize_ohlc_df(history)
    if history.empty or "Close" not in history.columns:
        return pd.DataFrame()

    history["Close"] = pd.to_numeric(history["Close"], errors="coerce")
    history = history.dropna(subset=["Close"])
    if not history.empty and isinstance(history.index, pd.DatetimeIndex):
        try:
            years = int(str(period).removesuffix("y"))
            cutoff = history.index[-1] - pd.DateOffset(years=years)
            history = history[history.index >= cutoff]
        except (TypeError, ValueError):
            pass
    return history


def _benchmark_for_ticker(ticker):
    symbol = (ticker or "").upper()
    suffix_map = {
        ".MI": "FTSEMIB.MI",
        ".DE": "^GDAXI",
        ".F": "^GDAXI",
        ".L": "^FTSE",
        ".PA": "^FCHI",
        ".AS": "^AEX",
        ".SW": "^SSMI",
        ".TO": "^GSPTSE",
        ".V": "^GSPTSE",
        ".HK": "^HSI",
        ".T": "^N225",
        ".AX": "^AXJO",
    }
    for suffix, benchmark in suffix_map.items():
        if symbol.endswith(suffix):
            return benchmark
    return "^GSPC"


SEC_COMPANYFACTS_CONCEPTS = {
    # Conto economico
    "TotalRevenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
    ),
    "CostOfRevenue": (
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
    ),
    "GrossProfit": ("GrossProfit",),
    "OperatingExpense": ("OperatingExpenses",),
    "SellingGeneralAndAdministration": (
        "SellingGeneralAndAdministrativeExpense",
    ),
    "ResearchAndDevelopment": (
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
    ),
    "OperatingIncome": ("OperatingIncomeLoss",),
    "NetNonOperatingInterestIncomeExpense": (
        "InterestIncomeExpenseNonoperatingNet",
    ),
    "OtherIncomeExpense": (
        "NonoperatingIncomeExpense",
        "OtherNonoperatingIncomeExpense",
    ),
    "PretaxIncome": (
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ),
    "TaxProvision": ("IncomeTaxExpenseBenefit",),
    "NetIncomeCommonStockholders": (
        "NetIncomeLossAvailableToCommonStockholdersBasic",
        "NetIncomeLoss",
        "ProfitLoss",
    ),
    "BasicEPS": ("EarningsPerShareBasic",),
    "DilutedEPS": ("EarningsPerShareDiluted",),
    "BasicAverageShares": ("WeightedAverageNumberOfSharesOutstandingBasic",),
    "DilutedAverageShares": (
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ),
    "TotalExpenses": ("CostsAndExpenses",),
    "InterestIncome": (
        "InterestIncomeNonoperating",
        "InvestmentIncomeInterest",
    ),
    "InterestExpense": (
        "InterestExpenseNonOperating",
        "InterestExpense",
    ),
    # Stato patrimoniale
    "TotalAssets": ("Assets",),
    "CurrentAssets": ("AssetsCurrent",),
    "CashCashEquivalentsAndShortTermInvestments": (
        "CashCashEquivalentsAndShortTermInvestments",
    ),
    "CashAndCashEquivalents": (
        "CashAndCashEquivalentsAtCarryingValue",
        "Cash",
    ),
    "OtherShortTermInvestments": (
        "ShortTermInvestments",
        "MarketableSecuritiesCurrent",
    ),
    "AccountsReceivable": (
        "AccountsReceivableNetCurrent",
        "AccountsNotesAndLoansReceivableNetCurrent",
    ),
    "Inventory": ("InventoryNet",),
    "TotalNonCurrentAssets": ("AssetsNoncurrent",),
    "NetPPE": ("PropertyPlantAndEquipmentNet",),
    "GoodwillAndOtherIntangibleAssets": (
        "GoodwillAndIntangibleAssetsNet",
    ),
    "Goodwill": ("Goodwill",),
    "TotalLiabilitiesNetMinorityInterest": ("Liabilities",),
    "CurrentLiabilities": ("LiabilitiesCurrent",),
    "AccountsPayable": (
        "AccountsPayableCurrent",
        "AccountsPayableAndAccruedLiabilitiesCurrent",
    ),
    "CurrentDebt": (
        "LongTermDebtCurrent",
        "ShortTermBorrowings",
        "ShortTermDebtCurrent",
        "LongTermDebtAndFinanceLeaseObligationsCurrent",
    ),
    "TotalNonCurrentLiabilitiesNetMinorityInterest": (
        "LiabilitiesNoncurrent",
    ),
    "LongTermDebt": (
        "LongTermDebtNoncurrent",
        "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    ),
    "TotalDebt": (
        "LongTermDebtAndFinanceLeaseObligations",
        "LongTermDebtAndCapitalLeaseObligations",
    ),
    "StockholdersEquity": (
        "StockholdersEquity",
        "CommonStockholdersEquity",
    ),
    "TotalEquityGrossMinorityInterest": (
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ),
    "OrdinarySharesNumber": ("CommonStockSharesOutstanding",),
    # Rendiconto finanziario
    "OperatingCashFlow": ("NetCashProvidedByUsedInOperatingActivities",),
    "InvestingCashFlow": ("NetCashProvidedByUsedInInvestingActivities",),
    "FinancingCashFlow": ("NetCashProvidedByUsedInFinancingActivities",),
    "EndCashPosition": (
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "CashAndCashEquivalentsAtCarryingValue",
    ),
    "IncomeTaxPaidSupplementalData": (
        "IncomeTaxesPaidNet",
        "IncomeTaxesPaid",
    ),
    "InterestPaidSupplementalData": (
        "InterestPaidNet",
        "InterestPaid",
    ),
    "CapitalExpenditure": (
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ),
    "PurchaseOfBusiness": (
        "PaymentsToAcquireBusinessesNetOfCashAcquired",
        "PaymentsToAcquireBusinessesGross",
    ),
    "IssuanceOfDebt": (
        "ProceedsFromIssuanceOfDebt",
        "ProceedsFromIssuanceOfLongTermDebt",
    ),
    "RepaymentOfDebt": (
        "RepaymentsOfDebt",
        "RepaymentsOfLongTermDebt",
    ),
    "IssuanceOfCapitalStock": (
        "ProceedsFromIssuanceOfCommonStock",
        "ProceedsFromStockOptionsExercised",
    ),
    "RepurchaseOfCapitalStock": (
        "PaymentsForRepurchaseOfCommonStock",
        "PaymentsForRepurchaseOfEquity",
    ),
    "CashDividendsPaid": (
        "PaymentsOfDividends",
        "PaymentsOfDividendsCommonStock",
    ),
    "ChangeInWorkingCapital": ("IncreaseDecreaseInOperatingCapital",),
    "ChangeInInventory": ("IncreaseDecreaseInInventories",),
    "ChangeInReceivables": (
        "IncreaseDecreaseInAccountsReceivable",
        "IncreaseDecreaseInAccountsAndNotesReceivable",
    ),
    "ChangeInPayable": (
        "IncreaseDecreaseInAccountsPayableAndAccruedLiabilities",
        "IncreaseDecreaseInAccountsPayable",
    ),
    "StockBasedCompensation": (
        "ShareBasedCompensation",
        "AllocatedShareBasedCompensationExpense",
    ),
    "DepreciationAndAmortization": (
        "DepreciationDepletionAndAmortization",
        "DepreciationDepletionAndAmortizationPropertyPlantAndEquipment",
    ),
    "NetIncomeFromContinuingOperations": (
        "NetIncomeLoss",
        "ProfitLoss",
    ),
}

SEC_ANNUAL_FORMS = {
    "10-K",
    "10-K/A",
    "20-F",
    "20-F/A",
    "40-F",
    "40-F/A",
}
SEC_NEGATIVE_CASH_FLOW_METRICS = {
    "CapitalExpenditure",
    "PurchaseOfBusiness",
    "RepaymentOfDebt",
    "RepurchaseOfCapitalStock",
    "CashDividendsPaid",
}
SEC_PER_SHARE_METRICS = {"BasicEPS", "DilutedEPS"}
SEC_SHARE_METRICS = {
    "BasicAverageShares",
    "DilutedAverageShares",
    "OrdinarySharesNumber",
}
SEC_INSTANT_METRICS = {
    row["key"]
    for row in FINANCIAL_STATEMENT_CONFIG["balance"]["rows"]
} | {
    "EndCashPosition",
    "Goodwill",
    "OtherShortTermInvestments",
}


def _sec_request_json(url, timeout=15):
    """Scarica JSON SEC con un User-Agent identificabile e configurabile."""
    user_agent = (
        os.environ.get("SEC_USER_AGENT")
        or "StockApp/1.0 (local financial research; configure SEC_USER_AGENT)"
    ).strip()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw_payload = response.read()
        if str(response.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw_payload = gzip.decompress(raw_payload)
    return json.loads(raw_payload.decode("utf-8"))


def _read_fundamental_training_cache_json(*parts):
    """Legge solo i file SEC già acquisiti dal trainer, se disponibili."""

    path = os.path.abspath(
        os.path.join(FUNDAMENTAL_TRAINING_CACHE_DIR, *parts)
    )
    cache_root = os.path.abspath(FUNDAMENTAL_TRAINING_CACHE_DIR)
    try:
        if os.path.commonpath([path, cache_root]) != cache_root:
            return {}
        with open(path, "r", encoding="utf-8") as cache_file:
            payload = json.load(cache_file)
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _resolve_sec_cik_from_training_cache(ticker):
    symbol = _normalized_sec_ticker(ticker)
    cached = _cache_get(
        sec_reference_cache,
        "training_company_tickers",
        SEC_REFERENCE_CACHE_TTL,
    )
    if isinstance(cached, dict):
        return cached.get(symbol)
    payload = _read_fundamental_training_cache_json("company_tickers.json")
    lookup = {}
    for entry in payload.values():
        if not isinstance(entry, dict):
            continue
        cached_symbol = _normalized_sec_ticker(entry.get("ticker"))
        try:
            cik = int(entry.get("cik_str"))
        except (TypeError, ValueError):
            continue
        if cached_symbol and cik > 0:
            lookup[cached_symbol] = cik
    _cache_set(
        sec_reference_cache,
        "training_company_tickers",
        lookup,
        max_size=4,
    )
    return lookup.get(symbol)


def _latest_fundamental_training_price(ticker):
    """Fallback locale: ultima chiusura grezza e relativa data."""

    symbol = re.sub(r"[^A-Z0-9._-]", "", str(ticker or "").upper())
    if not symbol:
        return None, None
    path = os.path.abspath(
        os.path.join(FUNDAMENTAL_TRAINING_CACHE_DIR, "prices", f"{symbol}.csv")
    )
    cache_root = os.path.abspath(FUNDAMENTAL_TRAINING_CACHE_DIR)
    try:
        if os.path.commonpath([path, cache_root]) != cache_root:
            return None, None
        frame = pd.read_csv(path, index_col=0)
    except (OSError, ValueError):
        return None, None
    if frame.empty or "Close" not in frame.columns:
        return None, None
    close = pd.to_numeric(frame["Close"], errors="coerce").dropna()
    if close.empty:
        return None, None
    latest_index = close.index[-1]
    try:
        price_as_of = pd.Timestamp(latest_index).date().isoformat()
    except (TypeError, ValueError):
        price_as_of = str(latest_index)[:10] or None
    return float(close.iloc[-1]), price_as_of


def _sec_ticker_lookup():
    cached = _cache_get_adaptive(
        sec_reference_cache,
        "company_tickers",
        SEC_REFERENCE_CACHE_TTL,
    )
    if cached is not None:
        return cached

    try:
        payload = _sec_request_json(
            "https://www.sec.gov/files/company_tickers.json",
        )
        entries = payload.values() if isinstance(payload, dict) else []
        lookup = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            ticker = str(entry.get("ticker") or "").strip().upper()
            try:
                cik = int(entry.get("cik_str"))
            except (TypeError, ValueError):
                continue
            if not ticker or cik <= 0:
                continue
            lookup[ticker] = cik
            lookup[ticker.replace(".", "-")] = cik
    except Exception:
        lookup = {}

    _cache_set(sec_reference_cache, "company_tickers", lookup, max_size=4)
    return lookup


SEC_EFTS_DISPLAY_NAME_PATTERN = re.compile(
    r"\(\s*"
    r"(?P<tickers>[A-Z0-9][A-Z0-9.\-]*"
    r"(?:\s*,\s*[A-Z0-9][A-Z0-9.\-]*)*)"
    r"\s*\)\s*"
    r"\(CIK\s+(?P<cik>\d{1,10})\)",
    re.IGNORECASE,
)


def _normalized_sec_ticker(value):
    return str(value or "").strip().upper().replace(".", "-")


def _extract_sec_cik_from_efts(payload, ticker):
    """Estrae il CIK solo da un ticker esatto nel gruppo tra parentesi."""
    expected = _normalized_sec_ticker(ticker)
    if not expected or not isinstance(payload, dict):
        return None

    display_names = []
    hits = payload.get("hits")
    hit_rows = hits.get("hits") if isinstance(hits, dict) else None
    if isinstance(hit_rows, list):
        for hit in hit_rows:
            source = hit.get("_source") if isinstance(hit, dict) else None
            names = source.get("display_names") if isinstance(source, dict) else None
            if isinstance(names, list):
                display_names.extend(names)
            elif isinstance(names, str):
                display_names.append(names)

    aggregations = payload.get("aggregations")
    entity_filter = (
        aggregations.get("entity_filter")
        if isinstance(aggregations, dict)
        else None
    )
    buckets = entity_filter.get("buckets") if isinstance(entity_filter, dict) else None
    if isinstance(buckets, list):
        for bucket in buckets:
            if isinstance(bucket, dict) and isinstance(bucket.get("key"), str):
                display_names.append(bucket["key"])

    for display_name in display_names:
        if not isinstance(display_name, str):
            continue
        for match in SEC_EFTS_DISPLAY_NAME_PATTERN.finditer(display_name):
            ticker_tokens = {
                _normalized_sec_ticker(token)
                for token in match.group("tickers").split(",")
            }
            if expected not in ticker_tokens:
                continue
            try:
                cik = int(match.group("cik"))
            except (TypeError, ValueError):
                continue
            if cik > 0:
                return cik
    return None


def _resolve_sec_cik_via_efts(ticker):
    symbol = _normalized_sec_ticker(ticker)
    cache_key = f"efts_cik:{symbol}"
    cached = _cache_get_adaptive(
        sec_reference_cache,
        cache_key,
        SEC_REFERENCE_CACHE_TTL,
        is_negative=lambda value: (
            not isinstance(value, dict) or value.get("cik") is None
        ),
    )
    if isinstance(cached, dict):
        return cached.get("cik")

    cik = None
    try:
        query = urllib.parse.urlencode(
            {
                "q": symbol,
                "from": 0,
                "size": 100,
            }
        )
        payload = _sec_request_json(
            f"https://efts.sec.gov/LATEST/search-index?{query}",
        )
        cik = _extract_sec_cik_from_efts(payload, symbol)
    except Exception:
        cik = None

    # Anche l'esito negativo viene memorizzato: un EFTS indisponibile non deve
    # rallentare ripetutamente le richieste dello stesso ticker.
    _cache_set(
        sec_reference_cache,
        cache_key,
        {"cik": cik},
        max_size=1000,
    )
    return cik


def _resolve_sec_cik(ticker):
    symbol = str(ticker or "").strip().upper()
    if not symbol or any(marker in symbol for marker in ("^", "=", "/", "\\")):
        return None
    symbol = _normalized_sec_ticker(symbol.split(":")[-1])
    primary_cik = _sec_ticker_lookup().get(symbol)
    if primary_cik is not None:
        return primary_cik
    cached_training_cik = _resolve_sec_cik_from_training_cache(symbol)
    if cached_training_cik is not None:
        return cached_training_cik
    return _resolve_sec_cik_via_efts(symbol)


def _fetch_sec_companyfacts_payload(ticker):
    cik = _resolve_sec_cik(ticker)
    if cik is None:
        return {}

    cache_key = f"{int(cik):010d}"
    cached = _cache_get_adaptive(
        sec_companyfacts_cache,
        cache_key,
        SEC_COMPANYFACTS_CACHE_TTL,
    )
    if cached is not None:
        return cached

    try:
        payload = _sec_request_json(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cache_key}.json",
        )
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}
    if not payload:
        payload = _read_fundamental_training_cache_json(
            "sec",
            cache_key,
            "companyfacts.json",
        )

    _cache_set(sec_companyfacts_cache, cache_key, payload, max_size=320)
    return payload


def _fetch_sec_submissions_payload(ticker):
    """Restituisce il payload SEC grezzo richiesto dalla pipeline ML.

    È tenuto separato da ``_fetch_sec_filings`` perché la vista utente limita
    intenzionalmente il numero di filing, mentre l'inferenza deve conservare
    accession e data/ora di accettazione.
    """

    cik = _resolve_sec_cik(ticker)
    if cik is None:
        return {}
    cache_key = f"{int(cik):010d}"
    cached = _cache_get_adaptive(
        sec_submissions_cache,
        cache_key,
        SEC_FILINGS_CACHE_TTL,
    )
    if cached is not None:
        return cached
    try:
        payload = _sec_request_json(
            f"https://data.sec.gov/submissions/CIK{cache_key}.json",
            timeout=10,
        )
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}
    if not payload:
        payload = _read_fundamental_training_cache_json(
            "sec",
            cache_key,
            "submissions.json",
        )
    _cache_set(sec_submissions_cache, cache_key, payload, max_size=320)
    return payload


def _load_fundamental_model_artifact():
    """Carica l'artifact JSON e lo aggiorna soltanto quando cambia su disco."""

    model_path = os.path.abspath(FUNDAMENTAL_MODEL_PATH)
    try:
        modified_at = os.path.getmtime(model_path)
    except OSError:
        return None

    if (
        _fundamental_model_state.get("path") == model_path
        and _fundamental_model_state.get("mtime") == modified_at
        and isinstance(_fundamental_model_state.get("artifact"), dict)
    ):
        return _fundamental_model_state["artifact"]

    try:
        with open(model_path, "r", encoding="utf-8") as model_file:
            artifact = json.load(model_file)
    except (OSError, ValueError):
        return None
    if (
        not isinstance(artifact, dict)
        or not isinstance(artifact.get("models"), dict)
        or not artifact.get("models")
    ):
        return None
    artifact_changed = (
        _fundamental_model_state.get("path") != model_path
        or _fundamental_model_state.get("mtime") != modified_at
    )
    _fundamental_model_state.update(
        {
            "path": model_path,
            "mtime": modified_at,
            "artifact": artifact,
        }
    )
    if artifact_changed:
        fundamental_forecast_cache.clear()
    return artifact


def _fundamental_model_ood(features, artifact):
    """Aggrega i limiti 1/99 dei tre orizzonti senza bloccare l'inferenza."""

    models = artifact.get("models") if isinstance(artifact, dict) else None
    if not isinstance(models, dict) or not models:
        return []
    warnings = set()
    for model in models.values():
        preprocessing = (
            model.get("preprocessing")
            if isinstance(model, dict)
            else None
        )
        if not isinstance(preprocessing, dict):
            continue
        names = preprocessing.get("featureNames") or []
        lower = preprocessing.get("lowerBounds") or []
        upper = preprocessing.get("upperBounds") or []
        for index, name in enumerate(names):
            if index >= len(lower) or index >= len(upper):
                continue
            value = _financial_number(features.get(name))
            if value is None:
                continue
            if value < lower[index] or value > upper[index]:
                warnings.add(name)
    return sorted(warnings)


def _fundamental_artifact_feature_names(artifact):
    """Raccoglie gli schemi globali e per-modello degli artifact v3-v5."""

    names = []
    seen = set()

    def add(value):
        if not isinstance(value, str):
            return
        name = value.strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "featureNames" and isinstance(child, (list, tuple)):
                    for feature_name in child:
                        add(feature_name)
                elif isinstance(child, (dict, list, tuple)):
                    visit(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                if isinstance(child, (dict, list, tuple)):
                    visit(child)

    visit(artifact if isinstance(artifact, dict) else {})
    return names


def _artifact_v5_feature_requirements(artifact):
    required = set(_fundamental_artifact_feature_names(artifact))
    market_names = set(V5_MARKET_FEATURE_NAMES) | set(
        V5_MARKET_MISSING_FLAG_NAMES
    )
    categorical_names = set(V5_CATEGORICAL_FEATURE_NAMES)
    return {
        "required": required,
        "market": sorted(required & market_names),
        "categorical": sorted(required & categorical_names),
    }


def _runtime_security_alias_row(alias, issuer):
    if not isinstance(alias, dict):
        return None
    return {
        "security_id": issuer.get("securityId"),
        "ticker": alias.get("ticker"),
        "canonical_ticker": issuer.get("canonicalTicker"),
        "price_ticker": alias.get("priceTicker") or alias.get("ticker"),
        "valid_from": alias.get("validFrom"),
        "valid_to": alias.get("validTo"),
        "delist_date": alias.get("delistDate"),
        "delisting_return": alias.get("delistingReturn"),
        "sector": alias.get("sector"),
        "industry": alias.get("industry"),
        "sic": alias.get("sic"),
        "exchange": alias.get("exchange"),
        "security_type": alias.get("securityType"),
        "sector_benchmark": alias.get("sectorBenchmark"),
        "cik": alias.get("cik"),
        "current_ticker": issuer.get("currentTicker"),
    }


def _resolve_artifact_security(artifact, ticker, as_of):
    """Risolve ticker/alias sul security master portabile incorporato nel modello."""

    dataset = artifact.get("dataset", {}) if isinstance(artifact, dict) else {}
    runtime = (
        dataset.get("securityMasterRuntime")
        if isinstance(dataset, dict)
        else None
    )
    if not isinstance(runtime, dict):
        return None, False
    issuers = runtime.get("issuers")
    if not isinstance(issuers, list):
        return None, True

    symbol = str(ticker or "").strip().upper()
    for issuer in issuers:
        if not isinstance(issuer, dict):
            continue
        aliases = issuer.get("aliases") or []
        identity_symbols = {
            str(issuer.get("canonicalTicker") or "").strip().upper(),
            str(issuer.get("currentTicker") or "").strip().upper(),
        }
        for alias in aliases:
            if not isinstance(alias, dict):
                continue
            identity_symbols.add(str(alias.get("ticker") or "").strip().upper())
            identity_symbols.add(
                str(alias.get("priceTicker") or "").strip().upper()
            )
        if symbol not in identity_symbols:
            continue
        timeline = [
            row
            for row in (
                _runtime_security_alias_row(alias, issuer) for alias in aliases
            )
            if row is not None
        ]
        resolved = resolve_security_point_in_time(timeline, as_of)
        return resolved, True
    return None, True


def _fundamental_market_benchmark(target_policy, security_row, ticker):
    benchmarks = (
        target_policy.get("benchmarks", {})
        if isinstance(target_policy, dict)
        else {}
    )
    if not isinstance(benchmarks, dict):
        benchmarks = {}
    raw_market = (
        benchmarks.get("market")
        or benchmarks.get("marketBenchmark")
        or benchmarks.get("market_benchmark")
    )
    if isinstance(raw_market, dict):
        raw_market = raw_market.get("ticker") or raw_market.get("symbol")
    if raw_market:
        return str(raw_market).strip().upper()

    # Il default US e un ETF negoziabile/total-return; per gli altri mercati
    # conserva il benchmark geografico gia usato dall'app.
    symbol = str(ticker or "").upper()
    if not any(symbol.endswith(suffix) for suffix in (
        ".MI", ".DE", ".F", ".L", ".PA", ".AS", ".SW", ".TO",
        ".V", ".HK", ".T", ".AX",
    )):
        return "SPY"
    return _benchmark_for_ticker(symbol)


def _fetch_live_earnings_events(stock, snapshot_at):
    """Converte il calendario Yahoo in record con disponibilita esplicita."""

    try:
        frame = stock.get_earnings_dates(limit=16)
    except Exception:
        return []
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return []

    snapshot = pd.Timestamp(snapshot_at)
    if snapshot.tzinfo is not None:
        snapshot = snapshot.tz_convert("UTC").tz_localize(None)
    records = []
    for index, row in frame.iterrows():
        try:
            event_at = pd.Timestamp(index)
            if event_at.tzinfo is not None:
                event_at = event_at.tz_convert("UTC").tz_localize(None)
        except (TypeError, ValueError):
            continue
        record = {"event_date": event_at.isoformat()}
        if event_at <= snapshot:
            # Per un evento trascorso la data/ora riportata e il primo cutoff
            # conservativo utilizzabile; nessuna surprise futura viene inclusa.
            record["published_at"] = event_at.isoformat()
            for column in ("Surprise(%)", "Surprise (%)", "surprisePercent"):
                surprise = _financial_number(row.get(column))
                if surprise is not None:
                    record["earnings_surprise_pct"] = surprise
                    break
            actual = _financial_number(
                row.get("Reported EPS", row.get("reportedEPS"))
            )
            estimate = _financial_number(
                row.get("EPS Estimate", row.get("epsEstimate"))
            )
            if actual is not None:
                record["actual_eps"] = actual
            if estimate is not None:
                record["estimate_eps"] = estimate
        else:
            # Il calendario e stato osservato adesso: questo timestamp prova
            # soltanto la disponibilita corrente, non una conoscenza storica.
            record["announced_at"] = snapshot.isoformat()
        records.append(record)
    return records


def _build_runtime_v5_features(
    artifact,
    ticker,
    quote_fields,
    chart_meta,
    submissions,
    security_row,
    snapshot_at,
):
    requirements = _artifact_v5_feature_requirements(artifact)
    output = {}
    audit = {
        "enabled": bool(requirements["market"] or requirements["categorical"]),
        "requiredMarketFeatures": requirements["market"],
        "requiredCategoricalFeatures": requirements["categorical"],
        "marketBenchmark": None,
        "marketFeatureCutoffDate": None,
        "earningsFeatureCutoffAt": None,
        "futureSourceRecordsRejected": 0,
        "missingRequiredFeatures": [],
    }
    if not audit["enabled"]:
        return output, audit

    if requirements["market"]:
        stock = yf.Ticker(ticker)
        stock_history = _fetch_analytics_history(
            ticker,
            stock,
            period="2y",
            auto_adjust=False,
        )
        target_policy = (artifact.get("dataset", {}) or {}).get(
            "targetPolicy", {}
        )
        benchmark_symbol = _fundamental_market_benchmark(
            target_policy,
            security_row,
            ticker,
        )
        benchmark_history = _fetch_analytics_history(
            benchmark_symbol,
            yf.Ticker(benchmark_symbol),
            period="2y",
            auto_adjust=False,
        )
        live_events = _fetch_live_earnings_events(stock, snapshot_at)
        market_features = build_market_event_features(
            stock_history,
            snapshot_at,
            market_frame=benchmark_history,
            shares_outstanding=quote_fields.get("sharesOutstanding"),
            earnings_events=live_events,
            # Nessuna revisione viene usata senza una sorgente timestamped.
            estimate_revisions=[],
        )
        if market_features.get("feature_lookahead_detected"):
            raise RuntimeError("Feature market/event con look-ahead rilevata.")
        output.update(
            {
                name: market_features.get(name)
                for name in (
                    *V5_MARKET_FEATURE_NAMES,
                    *V5_MARKET_MISSING_FLAG_NAMES,
                )
            }
        )
        audit.update(
            {
                "marketBenchmark": benchmark_symbol,
                "marketFeatureCutoffDate": market_features.get(
                    "market_feature_cutoff_date"
                ),
                "earningsFeatureCutoffAt": market_features.get(
                    "earnings_feature_cutoff_at"
                ),
                "futureSourceRecordsRejected": market_features.get(
                    "future_source_records_rejected", 0
                ),
            }
        )

    if requirements["categorical"]:
        row = security_row or {}
        categorical_values = {
            "security_sector": row.get("sector") or quote_fields.get("sector"),
            "security_sic": row.get("sic") or submissions.get("sic"),
            "security_industry": (
                row.get("industry")
                or quote_fields.get("industry")
                or submissions.get("sicDescription")
            ),
            "security_exchange": (
                row.get("exchange")
                or chart_meta.get("fullExchangeName")
                or chart_meta.get("exchangeName")
                or quote_fields.get("exchange")
            ),
            "security_type": (
                row.get("security_type")
                or chart_meta.get("instrumentType")
                or quote_fields.get("quoteType")
            ),
        }
        output.update(categorical_values)

    audit["missingRequiredFeatures"] = sorted(
        name
        for name in requirements["market"] + requirements["categorical"]
        if output.get(name) in (None, "")
    )
    return output, audit


SEC_FILING_CATEGORIES = {
    "annual": {
        "forms": {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"},
        "label": "Relazione annuale",
        "limit": 3,
    },
    "quarterly": {
        "forms": {"10-Q", "10-Q/A"},
        "label": "Relazione trimestrale",
        "limit": 4,
    },
    "current": {
        "forms": {"8-K", "8-K/A", "6-K", "6-K/A"},
        "label": "Aggiornamento rilevante",
        "limit": 4,
    },
    "proxy": {
        "forms": {"DEF 14A", "DEF 14C"},
        "label": "Assemblea e governance",
        "limit": 1,
    },
}


def _parse_sec_submissions(payload):
    """Converte il blocco ``filings.recent`` in link EDGAR verificabili."""
    if not isinstance(payload, dict):
        return {
            "available": False,
            "items": [],
            "reason": "Risposta SEC non valida.",
        }

    try:
        cik = int(payload.get("cik"))
    except (TypeError, ValueError):
        cik = None
    if cik is None or cik <= 0:
        return {
            "available": False,
            "items": [],
            "reason": "CIK SEC non disponibile.",
        }

    filings = payload.get("filings")
    recent = filings.get("recent") if isinstance(filings, dict) else None
    if not isinstance(recent, dict):
        recent = {}

    forms = recent.get("form") if isinstance(recent.get("form"), list) else []
    accessions = (
        recent.get("accessionNumber")
        if isinstance(recent.get("accessionNumber"), list)
        else []
    )
    filing_dates = (
        recent.get("filingDate")
        if isinstance(recent.get("filingDate"), list)
        else []
    )
    report_dates = (
        recent.get("reportDate")
        if isinstance(recent.get("reportDate"), list)
        else []
    )
    accepted_dates = (
        recent.get("acceptanceDateTime")
        if isinstance(recent.get("acceptanceDateTime"), list)
        else []
    )
    primary_documents = (
        recent.get("primaryDocument")
        if isinstance(recent.get("primaryDocument"), list)
        else []
    )
    primary_descriptions = (
        recent.get("primaryDocDescription")
        if isinstance(recent.get("primaryDocDescription"), list)
        else []
    )

    category_by_form = {
        form: (category_key, category["label"])
        for category_key, category in SEC_FILING_CATEGORIES.items()
        for form in category["forms"]
    }
    category_items = {
        category_key: []
        for category_key in SEC_FILING_CATEGORIES
    }

    def list_value(values, index):
        if index >= len(values):
            return ""
        return str(values[index] or "").strip()

    for index, raw_form in enumerate(forms):
        form = str(raw_form or "").strip().upper()
        category = category_by_form.get(form)
        if category is None:
            continue

        accession = list_value(accessions, index)
        if not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
            continue
        accession_compact = accession.replace("-", "")
        filing_date = list_value(filing_dates, index)
        report_date = list_value(report_dates, index)
        accepted_at = list_value(accepted_dates, index)
        primary_document = list_value(primary_documents, index)
        primary_description = list_value(primary_descriptions, index)
        safe_primary_document = (
            primary_document
            if re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._-]*",
                primary_document,
            )
            else ""
        )

        archive_root = (
            f"https://www.sec.gov/Archives/edgar/data/"
            f"{cik}/{accession_compact}"
        )
        category_key, category_label = category
        category_items[category_key].append(
            {
                "form": form,
                "category": category_key,
                "categoryLabel": category_label,
                "filingDate": filing_date or None,
                "reportDate": report_date or None,
                "acceptedAt": accepted_at or None,
                "accessionNumber": accession,
                "description": primary_description or category_label,
                "filingUrl": f"{archive_root}/{accession}-index.html",
                "documentUrl": (
                    f"{archive_root}/{safe_primary_document}"
                    if safe_primary_document
                    else None
                ),
            }
        )

    selected = []
    for category_key, category in SEC_FILING_CATEGORIES.items():
        ordered = sorted(
            category_items[category_key],
            key=lambda item: (
                item.get("filingDate") or "",
                item.get("accessionNumber") or "",
            ),
            reverse=True,
        )
        selected.extend(ordered[: category["limit"]])

    selected.sort(
        key=lambda item: (
            item.get("filingDate") or "",
            item.get("accessionNumber") or "",
        ),
        reverse=True,
    )
    company_name = str(payload.get("name") or "").strip() or None
    company_url = (
        f"https://www.sec.gov/edgar/browse/?CIK={cik:010d}&owner=exclude"
    )
    return {
        "available": bool(selected),
        "provider": "SEC EDGAR",
        "cik": f"{cik:010d}",
        "companyName": company_name,
        "companyUrl": company_url,
        "items": selected,
        "reason": (
            None
            if selected
            else "Nessun filing finanziario recente disponibile su SEC EDGAR."
        ),
    }


def _fetch_sec_filings(ticker):
    cik = _resolve_sec_cik(ticker)
    if cik is None:
        return {
            "available": False,
            "provider": "SEC EDGAR",
            "items": [],
            "reason": "Il ticker non risulta associato a un emittente SEC.",
        }

    cache_key = f"{int(cik):010d}"
    cached = _cache_get(
        sec_filings_cache,
        cache_key,
        SEC_FILINGS_CACHE_TTL,
    )
    if cached is not None:
        return cached

    try:
        payload = _sec_request_json(
            f"https://data.sec.gov/submissions/CIK{cache_key}.json",
            timeout=8,
        )
        parsed = _parse_sec_submissions(payload)
    except Exception:
        parsed = {
            "available": False,
            "provider": "SEC EDGAR",
            "cik": cache_key,
            "companyUrl": (
                f"https://www.sec.gov/edgar/browse/"
                f"?CIK={cache_key}&owner=exclude"
            ),
            "items": [],
            "reason": "SEC EDGAR temporaneamente non raggiungibile.",
        }

    _cache_set(sec_filings_cache, cache_key, parsed, max_size=320)
    return parsed


def _sec_fact_entries(fact, metric_key):
    units = fact.get("units") if isinstance(fact, dict) else None
    if not isinstance(units, dict):
        return []

    if metric_key in SEC_PER_SHARE_METRICS:
        preferred = [
            key
            for key in units
            if "share" in key.lower() and "/" in key
        ]
    elif metric_key in SEC_SHARE_METRICS:
        preferred = [
            key
            for key in units
            if key.lower().replace(" ", "") in {"shares", "share"}
        ]
    else:
        preferred = [
            key
            for key in units
            if key == "USD"
        ]
        preferred.extend(
            key
            for key in units
            if key not in preferred
            and re.fullmatch(r"[A-Z]{3}", str(key))
        )

    for unit_key in preferred:
        entries = units.get(unit_key)
        if isinstance(entries, list):
            return entries
    return []


def _parse_sec_annual_fact(fact, metric_key):
    """Normalizza un fact us-gaap annuale e sceglie il filing più recente."""
    selected = {}
    is_instant = metric_key in SEC_INSTANT_METRICS

    for entry in _sec_fact_entries(fact, metric_key):
        if not isinstance(entry, dict):
            continue
        form = str(entry.get("form") or "").strip().upper()
        fiscal_period = str(entry.get("fp") or "").strip().upper()
        if form not in SEC_ANNUAL_FORMS or fiscal_period not in {"", "FY"}:
            continue

        end_key = str(entry.get("end") or "").strip()
        try:
            end_date = datetime.strptime(end_key, "%Y-%m-%d")
        except (TypeError, ValueError):
            continue

        span_days = None
        start_key = str(entry.get("start") or "").strip()
        if start_key:
            try:
                span_days = (end_date - datetime.strptime(start_key, "%Y-%m-%d")).days
            except (TypeError, ValueError):
                continue
        if not is_instant and (span_days is None or not 250 <= span_days <= 430):
            continue

        value = _financial_number(entry.get("val"))
        if value is None:
            continue
        if metric_key in SEC_NEGATIVE_CASH_FLOW_METRICS:
            value = -abs(value)

        filed = str(entry.get("filed") or "")
        accession = str(entry.get("accn") or "")
        score = (
            filed,
            accession,
            -abs((span_days if span_days is not None else 365) - 365),
        )
        previous = selected.get(end_key)
        if previous is None or score > previous[0]:
            selected[end_key] = (score, value)

    newest_periods = sorted(selected, reverse=True)[:10]
    return {
        period_key: selected[period_key][1]
        for period_key in newest_periods
    }


def _derive_sec_metric(dated_values, target_key, left_key, right_key, operation):
    target = dated_values.setdefault(target_key, {})
    left_values = dated_values.get(left_key, {})
    right_values = dated_values.get(right_key, {})
    for period_key in set(left_values).intersection(right_values):
        if period_key in target:
            continue
        left = _financial_number(left_values.get(period_key))
        right = _financial_number(right_values.get(period_key))
        if left is None or right is None:
            continue
        value = operation(left, right)
        if _financial_number(value) is not None:
            target[period_key] = value
    if not target:
        dated_values.pop(target_key, None)


def _parse_sec_companyfacts(payload):
    facts = payload.get("facts") if isinstance(payload, dict) else None
    us_gaap = facts.get("us-gaap") if isinstance(facts, dict) else None
    if not isinstance(us_gaap, dict):
        return {}

    dated_values = {}
    for metric_key, concept_names in SEC_COMPANYFACTS_CONCEPTS.items():
        target = {}
        for concept_name in concept_names:
            concept_values = _parse_sec_annual_fact(
                us_gaap.get(concept_name),
                metric_key,
            )
            for period_key, value in concept_values.items():
                target.setdefault(period_key, value)
        if target:
            dated_values[metric_key] = target

    # Derivazioni prudenti: si calcolano solo quando entrambi i componenti
    # dello stesso esercizio SEC sono disponibili.
    _derive_sec_metric(
        dated_values,
        "GrossProfit",
        "TotalRevenue",
        "CostOfRevenue",
        lambda revenue, cost: revenue - cost,
    )
    _derive_sec_metric(
        dated_values,
        "OperatingIncome",
        "GrossProfit",
        "OperatingExpense",
        lambda gross_profit, expenses: gross_profit - expenses,
    )
    _derive_sec_metric(
        dated_values,
        "TotalExpenses",
        "CostOfRevenue",
        "OperatingExpense",
        lambda cost, operating_expenses: cost + operating_expenses,
    )
    _derive_sec_metric(
        dated_values,
        "TotalNonCurrentAssets",
        "TotalAssets",
        "CurrentAssets",
        lambda total, current: total - current,
    )
    _derive_sec_metric(
        dated_values,
        "TotalNonCurrentLiabilitiesNetMinorityInterest",
        "TotalLiabilitiesNetMinorityInterest",
        "CurrentLiabilities",
        lambda total, current: total - current,
    )
    _derive_sec_metric(
        dated_values,
        "TotalDebt",
        "CurrentDebt",
        "LongTermDebt",
        lambda current_debt, long_term_debt: current_debt + long_term_debt,
    )
    _derive_sec_metric(
        dated_values,
        "CashCashEquivalentsAndShortTermInvestments",
        "CashAndCashEquivalents",
        "OtherShortTermInvestments",
        lambda cash, investments: cash + investments,
    )
    _derive_sec_metric(
        dated_values,
        "WorkingCapital",
        "CurrentAssets",
        "CurrentLiabilities",
        lambda assets, liabilities: assets - liabilities,
    )
    _derive_sec_metric(
        dated_values,
        "FreeCashFlow",
        "OperatingCashFlow",
        "CapitalExpenditure",
        lambda operating_cash, capex: operating_cash + capex,
    )
    return dated_values


def _fetch_financial_timeseries_sec(ticker, frequency):
    if frequency != "annual":
        return {}, {}
    try:
        payload = _fetch_sec_companyfacts_payload(ticker)
        return _parse_sec_companyfacts(payload), {}
    except Exception:
        # La SEC è una fonte di completamento: non deve mai interrompere Yahoo.
        return {}, {}


def _financial_number(value):
    if isinstance(value, dict):
        value = value.get("raw")
    try:
        number = float(value)
        return number if np.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _statement_metric_keys(statement_key):
    statement = FINANCIAL_STATEMENT_CONFIG[statement_key]
    keys = [row["key"] for row in statement["rows"]]
    source_key = {
        "income": "financials",
        "balance": "balance-sheet",
        "cash": "cash-flow",
    }[statement_key]
    if yf_const is not None:
        try:
            yahoo_keys = yf_const.fundamentals_keys.get(source_key, [])
        except Exception:
            yahoo_keys = []
        for key in yahoo_keys:
            if key not in keys:
                keys.append(key)
    return keys


def _fetch_financial_series_request(ticker, prefix, metric_keys):
    requested_types = [f"{prefix}{key}" for key in metric_keys]
    encoded_symbol = urllib.parse.quote(ticker, safe="")
    encoded_types = urllib.parse.quote(",".join(requested_types), safe=",")
    period1 = int(datetime(2016, 1, 1, tzinfo=timezone.utc).timestamp())
    period2 = int((datetime.now(timezone.utc) + timedelta(days=2)).timestamp())
    url = (
        "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/"
        f"timeseries/{encoded_symbol}?symbol={encoded_symbol}&type={encoded_types}"
        f"&period1={period1}&period2={period2}"
    )

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}, {}

    results = payload.get("timeseries", {}).get("result") or []
    dated_values = {}
    trailing_values = {}

    for item in results:
        if not isinstance(item, dict):
            continue
        for series_key, entries in item.items():
            if not isinstance(entries, list):
                continue
            if prefix != "trailing" and series_key.startswith(prefix):
                metric_key = series_key[len(prefix):]
                target = dated_values.setdefault(metric_key, {})
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    as_of_date = entry.get("asOfDate")
                    value = _financial_number(entry.get("reportedValue"))
                    if as_of_date and value is not None:
                        target[str(as_of_date)] = value
            elif prefix == "trailing" and series_key.startswith("trailing"):
                metric_key = series_key[len("trailing"):]
                valid_entries = []
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    value = _financial_number(entry.get("reportedValue"))
                    if value is not None:
                        valid_entries.append((str(entry.get("asOfDate") or ""), value))
                if valid_entries:
                    trailing_values[metric_key] = sorted(valid_entries)[-1][1]

    return dated_values, trailing_values


def _fetch_financial_timeseries_direct(ticker, frequency):
    prefix = "annual" if frequency == "annual" else "quarterly"
    jobs = []
    for statement_key, statement in FINANCIAL_STATEMENT_CONFIG.items():
        metric_keys = _statement_metric_keys(statement_key)
        jobs.append((prefix, metric_keys))
        if statement.get("includeTtm"):
            jobs.append(("trailing", metric_keys))

    dated_values = {}
    trailing_values = {}
    with ThreadPoolExecutor(max_workers=min(5, len(jobs))) as executor:
        futures = {
            executor.submit(
                _fetch_financial_series_request,
                ticker,
                job_prefix,
                metric_keys,
            ): job_prefix
            for job_prefix, metric_keys in jobs
        }
        for future in as_completed(futures):
            try:
                job_dated, job_trailing = future.result()
            except Exception:
                continue
            for metric_key, values in job_dated.items():
                dated_values.setdefault(metric_key, {}).update(values)
            trailing_values.update(job_trailing)

    return dated_values, trailing_values


def _fetch_financial_timeseries_yfinance(ticker, frequency):
    stock = yf.Ticker(ticker)
    yf_frequency = "yearly" if frequency == "annual" else "quarterly"
    dated_values = {}
    trailing_values = {}

    getter_by_statement = {
        "income": "get_income_stmt",
        "balance": "get_balance_sheet",
        "cash": "get_cash_flow",
    }
    for statement_key, getter_name in getter_by_statement.items():
        getter = getattr(stock, getter_name, None)
        if not callable(getter):
            continue
        try:
            frame = getter(freq=yf_frequency)
        except Exception:
            frame = pd.DataFrame()
        if isinstance(frame, pd.DataFrame) and not frame.empty:
            for metric_key in _statement_metric_keys(statement_key):
                if metric_key not in frame.index:
                    continue
                target = dated_values.setdefault(metric_key, {})
                for column in frame.columns:
                    value = _financial_number(frame.at[metric_key, column])
                    if value is None:
                        continue
                    try:
                        date_key = pd.Timestamp(column).strftime("%Y-%m-%d")
                    except Exception:
                        date_key = str(column)
                    target[date_key] = value

        if not FINANCIAL_STATEMENT_CONFIG[statement_key].get("includeTtm"):
            continue
        try:
            trailing_frame = getter(freq="trailing")
        except Exception:
            trailing_frame = pd.DataFrame()
        if not isinstance(trailing_frame, pd.DataFrame) or trailing_frame.empty:
            continue
        for metric_key in _statement_metric_keys(statement_key):
            if metric_key not in trailing_frame.index:
                continue
            values = pd.to_numeric(
                trailing_frame.loc[metric_key],
                errors="coerce",
            ).dropna()
            if not values.empty:
                trailing_values[metric_key] = float(values.iloc[0])

    return dated_values, trailing_values


def _align_sec_periods_to_yahoo(yahoo_dated, sec_dated, max_days=45):
    """Allinea globalmente gli esercizi SEC alle date fiscali Yahoo vicine."""

    def parsed_dates(source):
        parsed = {}
        for period_values in (source or {}).values():
            if not isinstance(period_values, dict):
                continue
            for period_key in period_values:
                normalized = str(period_key)
                if normalized in parsed:
                    continue
                try:
                    parsed[normalized] = datetime.strptime(
                        normalized,
                        "%Y-%m-%d",
                    )
                except (TypeError, ValueError):
                    continue
        return parsed

    yahoo_dates = parsed_dates(yahoo_dated)
    sec_dates = parsed_dates(sec_dated)
    if not yahoo_dates or not sec_dates:
        return {
            metric_key: (
                dict(period_values)
                if isinstance(period_values, dict)
                else period_values
            )
            for metric_key, period_values in (sec_dated or {}).items()
        }

    try:
        allowed_distance = max(0, int(max_days))
    except (TypeError, ValueError):
        allowed_distance = 45

    yahoo_ordered = tuple(
        sorted(yahoo_dates, key=lambda key: yahoo_dates[key])
    )
    sec_ordered = tuple(
        sorted(sec_dates, key=lambda key: sec_dates[key])
    )

    def quality(score):
        matches, same_month, total_distance, largest_distance = score
        return (
            matches,
            same_month,
            -total_distance,
            -largest_distance,
        )

    @lru_cache(maxsize=None)
    def best_matching(sec_index, yahoo_index):
        if sec_index >= len(sec_ordered) or yahoo_index >= len(yahoo_ordered):
            return (0, 0, 0, 0), ()

        options = [
            best_matching(sec_index + 1, yahoo_index),
            best_matching(sec_index, yahoo_index + 1),
        ]
        sec_key = sec_ordered[sec_index]
        yahoo_key = yahoo_ordered[yahoo_index]
        distance = abs((sec_dates[sec_key] - yahoo_dates[yahoo_key]).days)
        if distance <= allowed_distance:
            remaining_score, remaining_pairs = best_matching(
                sec_index + 1,
                yahoo_index + 1,
            )
            same_month = int(
                sec_dates[sec_key].year == yahoo_dates[yahoo_key].year
                and sec_dates[sec_key].month == yahoo_dates[yahoo_key].month
            )
            matched_score = (
                remaining_score[0] + 1,
                remaining_score[1] + same_month,
                remaining_score[2] + distance,
                max(remaining_score[3], distance),
            )
            options.append(
                (
                    matched_score,
                    ((sec_key, yahoo_key),) + remaining_pairs,
                )
            )

        # A parità di qualità la sequenza di coppie rende il risultato stabile
        # e tende a conservare gli abbinamenti più recenti.
        return max(
            options,
            key=lambda candidate: (
                quality(candidate[0]),
                candidate[1],
            ),
        )

    _, matched_pairs = best_matching(0, 0)
    alignment = {
        sec_key: yahoo_key
        for sec_key, yahoo_key in matched_pairs
    }

    aligned = {}
    for metric_key, period_values in (sec_dated or {}).items():
        if not isinstance(period_values, dict):
            aligned[metric_key] = period_values
            continue
        target = {}
        priorities = {}
        for raw_period_key, value in period_values.items():
            period_key = str(raw_period_key)
            aligned_key = alignment.get(period_key, period_key)
            distance = (
                abs((sec_dates[period_key] - yahoo_dates[aligned_key]).days)
                if period_key in sec_dates and aligned_key in yahoo_dates
                else 0
            )
            priority = (
                0 if period_key == aligned_key else 1,
                distance,
                period_key,
            )
            if aligned_key not in target or priority < priorities[aligned_key]:
                target[aligned_key] = value
                priorities[aligned_key] = priority
        aligned[metric_key] = target
    return aligned


def _merge_financial_timeseries(
    primary_dated,
    primary_trailing,
    fallback_dated,
    fallback_trailing,
):
    """Completa una serie primaria senza sostituirne i valori validi."""
    merged_dated = {}

    # Il fallback viene copiato per primo: i valori validi della fonte diretta,
    # applicati per ultimi, mantengono sempre la priorità.
    for source in (fallback_dated or {}, primary_dated or {}):
        for metric_key, period_values in source.items():
            if not isinstance(period_values, dict):
                continue
            target = merged_dated.setdefault(metric_key, {})
            for period_key, value in period_values.items():
                if _financial_number(value) is not None:
                    target[str(period_key)] = value

    merged_trailing = {}
    for source in (fallback_trailing or {}, primary_trailing or {}):
        for metric_key, value in source.items():
            if _financial_number(value) is not None:
                merged_trailing[metric_key] = value

    return merged_dated, merged_trailing


def _fetch_financial_timeseries(ticker, frequency):
    try:
        direct_dated, direct_trailing = _fetch_financial_timeseries_direct(
            ticker,
            frequency,
        )
    except Exception:
        direct_dated, direct_trailing = {}, {}

    # Anche una risposta non vuota può essere parziale per singola voce o
    # esercizio. yfinance viene quindi usato come integrazione; il merge
    # conserva i valori della fonte diretta in caso di sovrapposizione.
    try:
        fallback_dated, fallback_trailing = _fetch_financial_timeseries_yfinance(
            ticker,
            frequency,
        )
    except Exception:
        fallback_dated, fallback_trailing = {}, {}

    yahoo_dated, yahoo_trailing = _merge_financial_timeseries(
        direct_dated,
        direct_trailing,
        fallback_dated,
        fallback_trailing,
    )

    # Company Facts completa, quando disponibile, lo storico annuale dei
    # titoli registrati presso la SEC. Yahoo resta sempre la fonte primaria:
    # il merge aggiunge soltanto periodi o metriche mancanti.
    try:
        sec_dated, _ = _fetch_financial_timeseries_sec(ticker, frequency)
    except Exception:
        sec_dated = {}
    sec_dated = _align_sec_periods_to_yahoo(yahoo_dated, sec_dated)
    return _merge_financial_timeseries(
        yahoo_dated,
        yahoo_trailing,
        sec_dated,
        {},
    )


FINANCIAL_EXTRA_LABELS = {
    "TaxEffectOfUnusualItems": "Effetto fiscale degli elementi non ricorrenti",
    "TaxRateForCalcs": "Aliquota fiscale utilizzata",
    "NormalizedEBITDA": "EBITDA normalizzato",
    "NormalizedDilutedEPS": "EPS diluito normalizzato",
    "NormalizedBasicEPS": "EPS base normalizzato",
    "TotalUnusualItems": "Elementi non ricorrenti totali",
    "TotalUnusualItemsExcludingGoodwill": "Elementi non ricorrenti escluso avviamento",
    "NetIncomeFromContinuingOperationNetMinorityInterest": "Utile da attività continuative netto minoranze",
    "ReconciledDepreciation": "Ammortamenti riconciliati",
    "ReconciledCostOfRevenue": "Costo dei ricavi riconciliato",
    "NetIncomeFromContinuingAndDiscontinuedOperation": "Utile da attività continuative e cessate",
    "ContinuingAndDiscontinuedDilutedEPS": "EPS diluito attività continuative e cessate",
    "ContinuingAndDiscontinuedBasicEPS": "EPS base attività continuative e cessate",
    "NetIncomeContinuousOperations": "Utile da attività continuative",
    "NetIncome": "Utile netto",
    "NetIncomeIncludingNoncontrollingInterests": "Utile netto incluse minoranze",
    "OtherNonOperatingIncomeExpenses": "Altri proventi e oneri non operativi",
    "InterestExpenseNonOperating": "Interessi passivi non operativi",
    "InterestIncomeNonOperating": "Interessi attivi non operativi",
    "OperatingRevenue": "Ricavi operativi",
    "OtherOperatingExpenses": "Altre spese operative",
    "DepreciationAndAmortizationInIncomeStatement": "Ammortamenti nel conto economico",
    "DepreciationIncomeStatement": "Ammortamento nel conto economico",
    "TreasurySharesNumber": "Numero azioni proprie",
    "PreferredSharesNumber": "Numero azioni privilegiate",
    "ShareIssued": "Azioni emesse",
    "NetTangibleAssets": "Attività tangibili nette",
    "CapitalLeaseObligations": "Obblighi per leasing finanziari",
    "CommonStockEquity": "Patrimonio netto azioni ordinarie",
    "TotalCapitalization": "Capitalizzazione totale",
    "GainsLossesNotAffectingRetainedEarnings": "Utili e perdite non imputati a riserva",
    "OtherEquityAdjustments": "Altre rettifiche del patrimonio netto",
    "RetainedEarnings": "Utili portati a nuovo",
    "AdditionalPaidInCapital": "Sovrapprezzo azioni",
    "CapitalStock": "Capitale sociale",
    "CommonStock": "Azioni ordinarie",
    "OtherCurrentAssets": "Altre attività correnti",
    "OtherNonCurrentAssets": "Altre attività non correnti",
    "OtherCurrentLiabilities": "Altre passività correnti",
    "OtherNonCurrentLiabilities": "Altre passività non correnti",
    "TradeandOtherPayablesNonCurrent": "Debiti commerciali e altri debiti non correnti",
    "PayablesAndAccruedExpenses": "Debiti e ratei passivi",
    "CurrentDebtAndCapitalLeaseObligation": "Debito corrente e leasing",
    "LongTermDebtAndCapitalLeaseObligation": "Debito a lungo termine e leasing",
    "LongTermCapitalLeaseObligation": "Obblighi di leasing a lungo termine",
    "CurrentDeferredLiabilities": "Passività differite correnti",
    "CurrentDeferredRevenue": "Ricavi differiti correnti",
    "CurrentCapitalLeaseObligation": "Obblighi di leasing correnti",
    "OtherCurrentBorrowings": "Altri finanziamenti correnti",
    "CommercialPaper": "Commercial paper",
    "CurrentAccruedExpenses": "Ratei passivi correnti",
    "Payables": "Debiti",
    "TotalTaxPayable": "Debiti tributari totali",
    "IncomeTaxPayable": "Imposte sul reddito da pagare",
    "NonCurrentDeferredAssets": "Attività differite non correnti",
    "NonCurrentDeferredTaxesAssets": "Attività fiscali differite non correnti",
    "InvestmentsAndAdvances": "Investimenti e anticipazioni",
    "OtherInvestments": "Altri investimenti",
    "InvestmentinFinancialAssets": "Investimenti in attività finanziarie",
    "AvailableForSaleSecurities": "Titoli disponibili per la vendita",
    "GrossPPE": "Immobili, impianti e macchinari lordi",
    "AccumulatedDepreciation": "Ammortamento accumulato",
    "Leases": "Leasing",
    "OtherProperties": "Altre proprietà",
    "MachineryFurnitureEquipment": "Macchinari, arredi e attrezzature",
    "LandAndImprovements": "Terreni e migliorie",
    "Properties": "Proprietà",
    "OtherShortTermInvestments": "Altri investimenti a breve termine",
    "Receivables": "Crediti",
    "OtherReceivables": "Altri crediti",
    "CashEquivalents": "Equivalenti di cassa",
    "CashFinancial": "Liquidità finanziaria",
    "FinishedGoods": "Prodotti finiti",
    "RawMaterials": "Materie prime",
    "ChangesInCash": "Variazione della liquidità",
    "BeginningCashPosition": "Liquidità iniziale",
    "EffectOfExchangeRateChanges": "Effetto delle variazioni dei cambi",
    "CashFlowFromContinuingFinancingActivities": "Flusso finanziario da attività continuative",
    "CashFlowFromContinuingInvestingActivities": "Flusso da investimenti delle attività continuative",
    "CashFlowFromContinuingOperatingActivities": "Flusso operativo da attività continuative",
    "NetOtherFinancingCharges": "Altri oneri finanziari netti",
    "CommonStockIssuance": "Emissione di azioni ordinarie",
    "CommonStockPayments": "Pagamenti per azioni ordinarie",
    "CommonStockDividendPaid": "Dividendi pagati su azioni ordinarie",
    "NetCommonStockIssuance": "Emissione netta di azioni ordinarie",
    "NetIssuancePaymentsOfDebt": "Emissioni e rimborsi netti del debito",
    "NetShortTermDebtIssuance": "Emissione netta di debito a breve termine",
    "NetLongTermDebtIssuance": "Emissione netta di debito a lungo termine",
    "ShortTermDebtPayments": "Rimborsi del debito a breve termine",
    "LongTermDebtPayments": "Rimborsi del debito a lungo termine",
    "LongTermDebtIssuance": "Emissione di debito a lungo termine",
    "NetInvestmentPurchaseAndSale": "Acquisto e vendita netta di investimenti",
    "PurchaseOfInvestment": "Acquisto di investimenti",
    "SaleOfInvestment": "Vendita di investimenti",
    "NetPPEPurchaseAndSale": "Acquisto e vendita netta di immobilizzazioni",
    "PurchaseOfPPE": "Acquisto di immobilizzazioni",
    "NetOtherInvestingChanges": "Altre variazioni nette da investimenti",
    "NetBusinessPurchaseAndSale": "Acquisti e cessioni nette di attività",
    "PurchaseOfBusiness": "Acquisizioni di attività",
    "ChangeInOtherWorkingCapital": "Variazione di altro capitale circolante",
    "ChangeInOtherCurrentLiabilities": "Variazione di altre passività correnti",
    "ChangeInOtherCurrentAssets": "Variazione di altre attività correnti",
    "ChangeInAccountPayable": "Variazione dei debiti commerciali",
    "ChangeInPayablesAndAccruedExpense": "Variazione debiti e ratei",
    "ChangesInAccountReceivables": "Variazione crediti commerciali",
    "OtherNonCashItems": "Altri elementi non monetari",
    "DeferredTax": "Imposte differite",
    "DeferredIncomeTax": "Imposte sul reddito differite",
    "DepreciationAmortizationDepletion": "Ammortamenti e svalutazioni",
    "OperatingGainsLosses": "Utili e perdite operative",
}


def _financial_label(metric_key):
    if metric_key in FINANCIAL_EXTRA_LABELS:
        return FINANCIAL_EXTRA_LABELS[metric_key]
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", metric_key)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return spaced.replace(" And ", " e ").replace(" Of ", " di ")


def _financial_format(metric_key):
    if (
        "EPS" in metric_key
        or metric_key.endswith("PerShare")
        or "Rate" in metric_key
        or "Margin" in metric_key
    ):
        return "perShare"
    return "number"


def _serialize_financial_statements(dated_values, trailing_values, frequency):
    max_periods = 10 if frequency == "annual" else 12
    statements = {}

    for statement_key, statement in FINANCIAL_STATEMENT_CONFIG.items():
        configured_rows = list(statement["rows"])
        configured_keys = {row["key"] for row in configured_rows}
        extra_rows = [
            {
                "key": metric_key,
                "label": _financial_label(metric_key),
                "format": _financial_format(metric_key),
                "detail": True,
            }
            for metric_key in _statement_metric_keys(statement_key)
            if metric_key not in configured_keys
        ]
        row_configs = configured_rows + extra_rows
        metric_keys = [row["key"] for row in row_configs]
        dates = sorted(
            {
                date
                for metric_key in metric_keys
                for date in dated_values.get(metric_key, {}).keys()
            },
            reverse=True,
        )[:max_periods]
        has_ttm = bool(
            statement.get("includeTtm")
            and any(trailing_values.get(metric_key) is not None for metric_key in metric_keys)
        )
        periods = ([{"key": "TTM", "label": "TTM"}] if has_ttm else [])
        periods.extend({"key": date, "label": date} for date in dates)

        rows = []
        for row_config in row_configs:
            metric_key = row_config["key"]
            values = {}
            if has_ttm:
                values["TTM"] = trailing_values.get(metric_key)
            for date in dates:
                values[date] = dated_values.get(metric_key, {}).get(date)
            if not any(value is not None for value in values.values()):
                continue
            rows.append(
                {
                    "key": metric_key,
                    "label": row_config["label"],
                    "format": row_config.get("format", "number"),
                    "detail": bool(row_config.get("detail")),
                    "values": values,
                }
            )

        statements[statement_key] = {
            "label": statement["label"],
            "periods": periods,
            "rows": rows,
        }

    return statements


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
        "regularMarketPrice": q0.get("regularMarketPrice"),
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
        "sector": q0.get("sector"),
        "industry": q0.get("industry"),
        "exchange": q0.get("fullExchangeName") or q0.get("exchange"),
        "quoteType": q0.get("quoteType"),
        "currency": q0.get("currency"),
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
        "netIncomeToCommon": raw(financial, "netIncomeToCommon") or raw(financial, "netIncome"),
        "currency": financial.get("financialCurrency"),
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
    text_keys = {"shortName", "sector", "currency"}
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
        "epsForward": pick("forwardEps", "epsForward"),
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
        "currency": pick("currency", "financialCurrency"),
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
            "currency": fi_pick("currency"),
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

    for text_key, out_key in (
        ("shortName", "shortName"),
        ("longName", "shortName"),
        ("sector", "sector"),
    ):
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


@app.route("/search/suggestions")
def search_suggestions():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"suggestions": []})

    if len(query) > 80:
        return jsonify({"error": "Ricerca troppo lunga"}), 400

    try:
        limit = max(1, min(int(request.args.get("limit", "8")), 10))
    except (TypeError, ValueError):
        limit = 8

    cache_key = f"{query.casefold()}:{limit}"
    cached = _cache_get(
        search_suggestions_cache,
        cache_key,
        SEARCH_SUGGESTIONS_CACHE_TTL,
    )
    if cached is not None:
        return jsonify(cached)

    try:
        params = urllib.parse.urlencode(
            {
                "q": query,
                "quotesCount": max(limit * 2, 8),
                "newsCount": 0,
                "listsCount": 0,
                "enableFuzzyQuery": "true",
                "quotesQueryId": "tss_match_phrase_query",
            }
        )
        url = f"https://query1.finance.yahoo.com/v1/finance/search?{params}"
        yahoo_request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            },
        )
        with urllib.request.urlopen(yahoo_request, timeout=8) as response:
            body = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                body = gzip.decompress(body)
            search_payload = json.loads(body.decode("utf-8"))
        results = search_payload.get("quotes") or []

        suggestions = []
        seen_symbols = set()
        for result in results:
            symbol = str(result.get("symbol") or "").strip().upper()
            if not symbol or symbol in seen_symbols:
                continue

            quote_type = str(
                result.get("quoteType")
                or result.get("typeDisp")
                or ""
            ).strip().upper()
            if quote_type in {"OPTION", "NONE"}:
                continue

            name = str(
                result.get("shortname")
                or result.get("longname")
                or result.get("name")
                or symbol
            ).strip()
            exchange = str(
                result.get("exchDisp")
                or result.get("exchange")
                or ""
            ).strip()

            suggestions.append(
                {
                    "symbol": symbol,
                    "name": name,
                    "exchange": exchange,
                    "type": quote_type,
                }
            )
            seen_symbols.add(symbol)
            if len(suggestions) >= limit:
                break

        payload = {"suggestions": suggestions}
        _cache_set(search_suggestions_cache, cache_key, payload, max_size=240)
        return jsonify(payload)
    except Exception as exc:
        print("Errore suggerimenti ricerca:", exc)
        return jsonify({"suggestions": [], "error": "Servizio suggerimenti temporaneamente non disponibile."}), 502


@app.route("/market/tradingview-heatmap")
def tradingview_heatmap():
    """Proxy compatto per i dati dello Stock Heatmap di TradingView."""
    cache_key = "spx500-stock-heatmap-v1"
    cached = _cache_get(
        stock_response_cache,
        cache_key,
        TRADINGVIEW_HEATMAP_CACHE_TTL,
    )
    if cached is not None:
        return jsonify(cached)

    query = {
        "symbols": {"query": {"types": []}, "tickers": []},
        "columns": [
            "name",
            "description",
            "close",
            "change",
            "change|1W",
            "change|1M",
            "market_cap_basic",
            "sector",
        ],
        "options": {"lang": "en"},
        "range": [0, 500],
        "sort": {"sortBy": "market_cap_basic", "sortOrder": "desc"},
    }
    try:
        scanner_request = urllib.request.Request(
            "https://scanner.tradingview.com/america/scan",
            data=json.dumps(query).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(scanner_request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))

        columns = query["columns"]
        rows = []
        for item in payload.get("data") or []:
            values = item.get("d") or []
            row = dict(zip(columns, values))
            symbol = str(item.get("s") or "").split(":")[-1].strip().upper()
            if not symbol or not row.get("market_cap_basic"):
                continue
            rows.append(
                {
                    "symbol": symbol,
                    "name": row.get("description") or row.get("name") or symbol,
                    "price": row.get("close"),
                    "change1D": row.get("change"),
                    "change1W": row.get("change|1W"),
                    "change1M": row.get("change|1M"),
                    "marketCap": row.get("market_cap_basic"),
                    "sector": _canonical_heatmap_sector(row.get("sector")),
                }
            )
        result = {"source": "TradingView", "dataSource": "SPX500", "rows": rows}
        _cache_set(stock_response_cache, cache_key, result, max_size=4)
        return jsonify(result)
    except Exception as exc:
        print("Errore heatmap TradingView:", exc)
        return jsonify({"error": "Dati TradingView temporaneamente non disponibili."}), 502


SECTOR_RELATION_ETFS = {
    "basic materials": "XLB",
    "materials": "XLB",
    "communication services": "XLC",
    "consumer cyclical": "XLY",
    "consumer cyclicals": "XLY",
    "consumer defensive": "XLP",
    "consumer staples": "XLP",
    "energy": "XLE",
    "financial services": "XLF",
    "financials": "XLF",
    "financial": "XLF",
    "healthcare": "XLV",
    "health care": "XLV",
    "industrials": "XLI",
    "real estate": "XLRE",
    "technology": "XLK",
    "utilities": "XLU",
}


def _heatmap_relation_history(symbol):
    """Fetch one adjusted daily close series, with the same provider fallbacks as history."""
    cached = _cache_get(heatmap_prices_cache, symbol, HEATMAP_RELATIONS_CACHE_TTL)
    if cached is not None:
        return cached
    for candidate in ticker_candidates(symbol):
        history = _fetch_interval_history(candidate, yf.Ticker(candidate), "5y", "1d", "5y")
        if history.empty or "Close" not in history.columns:
            continue
        price_column = "Adj Close" if "Adj Close" in history.columns and history["Adj Close"].notna().sum() >= 60 else "Close"
        series = pd.to_numeric(history[price_column], errors="coerce").replace([np.inf, -np.inf], np.nan)
        series = series.where(series > 0)
        if series.notna().sum() < 40:
            continue
        try:
            index = pd.to_datetime(series.index)
            if index.tz is None and history.attrs.get("timestampTimezone") == "UTC":
                timezone = history.attrs.get("exchangeTimezoneName")
                if timezone:
                    index = index.tz_localize("UTC").tz_convert(timezone)
            series.index = index.tz_localize(None).normalize()
        except Exception:
            series.index = pd.to_datetime(series.index, errors="coerce").normalize()
        series = series[~series.index.isna()]
        series = series[~series.index.duplicated(keep="last")].sort_index()
        # Conservative completed-day cutoff, consistent for stock and factors.
        # Never train or score on today's potentially still-open daily bar.
        series = series.loc[series.index < pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()]
        series.attrs["priceBasis"] = "adjusted" if price_column == "Adj Close" else "close"
        if series.notna().sum() >= 40:
            result = (series, candidate)
            _cache_set(heatmap_prices_cache, symbol, result, max_size=192)
            return result
    return pd.Series(dtype=float), None


HEATMAP_SECTOR_ALIASES = {
    "basic materials": "Basic Materials",
    "materials": "Basic Materials",
    "communication services": "Communication Services",
    "consumer cyclical": "Consumer Cyclical",
    "consumer cyclicals": "Consumer Cyclical",
    "consumer discretionary": "Consumer Cyclical",
    "consumer defensive": "Consumer Defensive",
    "consumer staples": "Consumer Defensive",
    "energy": "Energy",
    "financial": "Financial Services",
    "financial services": "Financial Services",
    "financials": "Financial Services",
    "health care": "Healthcare",
    "healthcare": "Healthcare",
    "industrials": "Industrials",
    "real estate": "Real Estate",
    "technology": "Technology",
    "information technology": "Technology",
    "tech": "Technology",
    "utilities": "Utilities",
}


def _canonical_heatmap_sector(value):
    raw = str(value or "").strip()
    if raw.casefold() in {"", "other", "altro", "n/a", "n/d", "unknown", "none", "null", "-"}:
        return "Other"
    key = re.sub(r"[\s_/-]+", " ", raw.casefold()).strip()
    return HEATMAP_SECTOR_ALIASES.get(key, raw)


def _heatmap_sector_metadata(symbol):
    """Resolve sector/name/cap for symbols outside the heat-map universe."""
    for candidate in ticker_candidates(symbol):
        merged = {}
        try:
            merged.update(_fetch_quote_fields(candidate))
        except Exception:
            pass
        if not merged.get("sector") or not merged.get("currency"):
            try:
                merged.update(_fetch_quote_page_fields(candidate))
            except Exception:
                pass
        if not merged.get("sector") or not merged.get("currency"):
            try:
                stock = yf.Ticker(candidate)
                raw_info = _safe_get_info(stock)
                merged_info = _normalize_info_payload(raw_info)
                # Industry and fund category are not interchangeable with sector.
                merged_info["sector"] = raw_info.get("sector")
                # Trading currency, never the financial statements' currency.
                merged_info["currency"] = raw_info.get("currency")
                for key, value in merged_info.items():
                    if merged.get(key) is None and value is not None:
                        merged[key] = value
            except Exception:
                pass
        if not merged.get("currency"):
            try:
                # Chart metadata also works when Yahoo's authenticated quote
                # or yfinance info endpoints are unavailable.
                _, chart_meta = _fetch_chart_data(candidate, "5d", "1d")
                merged["currency"] = (chart_meta or {}).get("currency")
            except Exception:
                pass
        sector = _canonical_heatmap_sector(merged.get("sector"))
        if sector != "Other" or merged.get("currency"):
            return {
                "symbol": normalize_ticker(candidate),
                "name": merged.get("shortName") or normalize_ticker(candidate),
                "sector": sector,
                "marketCap": merged.get("marketCap"),
                "currency": merged.get("currency"),
            }
    return {}


def _heatmap_currency(value):
    """Return major quote currency and price-unit multiplier (not FX)."""
    raw = str(value or "").strip()
    minor_units = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01),
                   "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}
    if raw in minor_units:
        return minor_units[raw]
    code = raw.upper()
    return (code, 1.0) if re.fullmatch(r"[A-Z]{3}", code) else (None, None)


def _heatmap_usd_fx(currency):
    """Historical units of target currency per USD; no backfill or invented FX."""
    for symbol, inverse in ((f"USD{currency}=X", False), (f"{currency}USD=X", True)):
        try:
            prices, resolved = _heatmap_relation_history(symbol)
        except Exception:
            continue
        clean = prices.where(np.isfinite(prices) & (prices > 0))
        if clean.notna().sum() >= 40:
            rates = 1.0 / clean if inverse else clean.copy()
            return rates, {"symbol": resolved or symbol, "inverse": inverse,
                           "units": f"{currency} per USD",
                           "lastDate": clean.last_valid_index().date().isoformat()}
    return pd.Series(dtype=float), None


def _heatmap_convert_usd(prices, fx):
    """Convert levels before calculating returns; preserve missing FX barriers."""
    converted = prices * fx.reindex(prices.index)
    converted.attrs = dict(prices.attrs)
    return converted


def _heatmap_prior_close(prices, calendar):
    """Cross-market features: only earlier calendar dates, at most 4 days old.

    Daily bars lack reliable close timestamps. Excluding same-date foreign
    bars conservatively prevents a US close from leaking into an Asian or
    European prediction. Invalid observations are never skipped/backfilled.
    """
    prices = prices.sort_index()
    result = pd.Series(np.nan, index=calendar, dtype=float)
    if not prices.empty:
        positions = prices.index.searchsorted(calendar, side="left") - 1
        valid = positions >= 0
        offsets = np.flatnonzero(valid)
        age = (calendar[valid] - prices.index[positions[valid]]).days
        offsets = offsets[age <= 4]
        result.iloc[offsets] = prices.iloc[positions[offsets]].to_numpy()
    result.attrs = dict(prices.attrs)
    return result


def _heatmap_relation_returns(series, lag):
    if series is None or len(series) <= lag:
        return pd.Series(dtype=float)
    valid = series.notna().rolling(lag + 1, min_periods=lag + 1).sum().eq(lag + 1)
    return series.pct_change(lag, fill_method=None).where(valid).replace([np.inf, -np.inf], np.nan).dropna()


def _heatmap_pair_stats(left, right, lag, minimum=40):
    frame = pd.concat([left, right], axis=1, join="inner").dropna()
    if len(frame) < minimum:
        return {"correlation": None, "beta": None, "observations": int(len(frame))}
    x = frame.iloc[:, 1].to_numpy(dtype=float)
    y = frame.iloc[:, 0].to_numpy(dtype=float)
    x_mean = float(np.mean(x))
    y_mean = float(np.mean(y))
    x_centered = x - x_mean
    y_centered = y - y_mean
    x_var = float(np.sum(x_centered ** 2))
    y_var = float(np.sum(y_centered ** 2))
    if x_var <= 1e-18 or y_var <= 1e-18:
        return {"correlation": None, "beta": None, "observations": int(len(frame))}
    covariance = float(np.sum(x_centered * y_centered))
    correlation = covariance / np.sqrt(x_var * y_var)
    beta = covariance / x_var
    return {
        "correlation": round(float(np.clip(correlation, -1, 1)), 6),
        "beta": round(float(beta), 6),
        "observations": int(len(frame)),
    }


def _heatmap_relation_ridge(target_returns, factor_returns, minimum=40):
    usable = {key: value for key, value in factor_returns.items() if isinstance(value, pd.Series) and not value.empty}
    if not usable:
        return {"status": "insufficient_data", "features": [], "observations": 0, "rSquared": None, "intercept": None, "scenarios": []}
    frame = pd.concat([target_returns.rename("target"), *[value.rename(key) for key, value in usable.items()]], axis=1, join="inner").dropna()
    if len(frame) < minimum:
        return {"status": "insufficient_data", "features": list(usable), "observations": int(len(frame)), "rSquared": None, "intercept": None, "scenarios": []}
    feature_names = list(usable)
    x = frame[feature_names].to_numpy(dtype=float)
    y = frame["target"].to_numpy(dtype=float)
    means = x.mean(axis=0)
    scales = x.std(axis=0, ddof=1)
    valid = np.isfinite(scales) & (scales > 1e-12)
    feature_names = [name for name, keep in zip(feature_names, valid) if keep]
    if not feature_names:
        return {"status": "insufficient_variation", "features": [], "observations": int(len(frame)), "rSquared": None, "intercept": None, "scenarios": []}
    x = frame[feature_names].to_numpy(dtype=float)
    means = x.mean(axis=0)
    scales = x.std(axis=0, ddof=1)
    standardized = (x - means) / scales
    alpha = 1.0
    matrix = standardized.T @ standardized + alpha * np.eye(len(feature_names))
    try:
        standardized_beta = np.linalg.solve(matrix, standardized.T @ y)
    except np.linalg.LinAlgError:
        standardized_beta = np.linalg.lstsq(matrix, standardized.T @ y, rcond=None)[0]
    beta = standardized_beta / scales
    intercept = float(y.mean() - np.dot(beta, means))
    fitted = intercept + x @ beta
    residual = y - fitted
    total_ss = float(np.sum((y - y.mean()) ** 2))
    r_squared = 1 - float(np.sum(residual ** 2)) / total_ss if total_ss > 1e-18 else None
    coefficients = [
        {"factor": name, "beta": round(float(value), 6), "betaPct": round(float(value), 4)}
        for name, value in zip(feature_names, beta)
    ]
    shocks = [-10, -5, 0, 5, 10]
    scenarios = [
        {
            "factor": name,
            "beta": round(float(value), 6),
            "shocks": [
                {"shockPct": shock, "predictedReturnPct": round(float((intercept + value * shock / 100) * 100), 4)}
                for shock in shocks
            ],
        }
        for name, value in zip(feature_names, beta)
    ]
    return {
        "status": "ready",
        "method": "ridge-standardized",
        "alpha": alpha,
        "features": coefficients,
        "observations": int(len(frame)),
        "rSquared": round(float(np.clip(r_squared, -1, 1)), 6) if r_squared is not None else None,
        "interceptPct": round(intercept * 100, 6),
        "scenarios": scenarios,
    }




def _load_page_daily_source(raw_ticker):
    """One completed daily snapshot shared by Technicals and Seasonality."""
    symbol = normalize_ticker(raw_ticker)
    key = f"pages-20y:{symbol}:{datetime.now(timezone.utc).date()}"
    source = _cache_get(page_daily_history_cache, key, timedelta(minutes=15))
    if source is not None:
        return source
    for candidate in ticker_candidates(symbol):
        for period in ("20y", "10y", "5y", "2y", "1y"):
            history = _fetch_interval_history(candidate, yf.Ticker(candidate), period, "1d", period)
            if history.empty:
                continue
            history = completed_daily_history(history)
            if history.empty:
                continue
            _, meta = _fetch_chart_data(candidate, "5d", "1d")
            columns = [c for c in ("Open", "High", "Low", "Close", "Adj Close", "Volume") if c in history]
            digest = hashlib.sha256(pd.util.hash_pandas_object(history[columns], index=True).values.tobytes()).hexdigest()[:20]
            history.attrs["pageSourceId"] = f"{candidate}:{digest}"
            history.attrs["actualLookbackRequest"] = period
            source = (history, candidate, meta or {})
            _cache_set(page_daily_history_cache, key, source, max_size=24)
            return source
    return pd.DataFrame(), symbol, {}




@app.route("/stock/<ticker>/structure-neural", methods=["POST"])
def structure_neural(ticker):
    symbol = normalize_ticker(ticker)
    if not symbol or len(symbol) > 32 or not re.fullmatch(r"[A-Z0-9.^=\-]+", symbol):
        return jsonify({"error": "Ticker non valido."}), 400
    if request.content_length and request.content_length > 300_000:
        return jsonify({"error": "Snapshot della pagina troppo grande."}), 413
    payload = request.get_json(silent=True)
    try:
        validate_neural_request(payload)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
        return jsonify({"error": "Parametri o dati della pagina non validi: ricarica Previsioni e seleziona 1D, 1W o 1M."}), 400
    if not structure_neural_lock.acquire(blocking=False):
        return jsonify({"error": "Un addestramento è già in corso. Riprova tra poco."}), 429
    try:
        history, resolved, meta = _load_page_daily_source(symbol)
        if history.empty:
            return jsonify({"error": "Storico non disponibile per la rete neurale."}), 502
        identity = hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()
        key = f"{STRUCTURE_NEURAL_VERSION}:{symbol}:{resolved}:{history.attrs.get('pageSourceId')}:{identity}"
        cached = _cache_get(structure_neural_cache, key, timedelta(minutes=30))
        if cached is not None:
            return jsonify(cached)
        result = build_structure_neural(history, payload)
        result.update(symbol=resolved, requestedSymbol=symbol, currency=meta.get("currency"), source="Yahoo Finance · geometria della pagina Previsioni",
                      sourceId=history.attrs.get("pageSourceId"), generatedAt=datetime.now(timezone.utc).isoformat())
        result = _json_safe(result)
        _cache_set(structure_neural_cache, key, result, max_size=24)
        return jsonify(result)
    except Exception as exc:
        print("Errore rete struttura:", type(exc).__name__)
        return jsonify({"error": "Rete neurale non disponibile. Verifica storico e dipendenze."}), 502
    finally:
        structure_neural_lock.release()


@app.route("/stock/<ticker>/structure-neural/jobs", methods=["POST"])
def structure_neural_submit(ticker):
    symbol = normalize_ticker(ticker)
    if not symbol or len(symbol) > 32 or not re.fullmatch(r"[A-Z0-9.^=\-]+", symbol):
        return jsonify({"error": "Ticker non valido."}), 400
    if request.content_length and request.content_length > 300_000:
        return jsonify({"error": "Snapshot troppo grande."}), 413
    payload = request.get_json(silent=True)
    try:
        validate_neural_request(payload)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
        return jsonify({"error": "Dati della pagina non validi: aggiorna Previsioni."}), 400
    try:
        from ml.structure_jobs import jobs
    except ImportError:
        from backend.ml.structure_jobs import jobs
    try:
        return jsonify(jobs.submit(symbol, payload)), 202
    except (TypeError, ValueError):
        return jsonify({"error": "Snapshot non serializzabile o non finito."}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 429


@app.route("/stock/<ticker>/structure-neural/jobs/<job_id>")
def structure_neural_job(ticker, job_id):
    try:
        from ml.structure_jobs import jobs
    except ImportError:
        from backend.ml.structure_jobs import jobs
    state = jobs.get(normalize_ticker(ticker), job_id)
    return (jsonify(state), 200) if state else (jsonify({"error": "Analisi non trovata: avviala nuovamente."}), 404)


@app.route("/market/heatmap-relations/<ticker>")
def heatmap_relations(ticker):
    """Cross-sectional sector model using daily, monthly and annual aligned returns."""
    requested = normalize_ticker(ticker)
    if not requested:
        return jsonify({"error": "Ticker non valido"}), 400
    sector_hint = _canonical_heatmap_sector(request.args.get("sector"))
    signal_cost_bps = _to_float(request.args.get("signalCostBps", "20"))
    if signal_cost_bps is None or not 0 <= signal_cost_bps <= 500:
        return jsonify({"error": "Costi non validi: inserire da 0 a 500 punti base."}), 400
    requested_version = request.args.get("signalVersion")
    if requested_version and requested_version != HEATMAP_SIGNAL_VERSION:
        return jsonify({"error": "Versione del segnale non compatibile: aggiornare la pagina."}), 409
    cache_key = f"heatmap-relations:v5-fx:{requested}:{sector_hint.casefold()}:{signal_cost_bps:g}"
    cached = _cache_get(heatmap_relations_cache, cache_key, HEATMAP_RELATIONS_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        heatmap_response = _cache_get(stock_response_cache, "spx500-stock-heatmap-v1", TRADINGVIEW_HEATMAP_CACHE_TTL)
        if heatmap_response is None:
            heatmap_response = tradingview_heatmap()
            if isinstance(heatmap_response, tuple):
                response_status = heatmap_response[1] if len(heatmap_response) > 1 else 200
                heatmap_response = heatmap_response[0]
                if response_status and int(response_status) >= 400:
                    heatmap_response = None
            heatmap_response = heatmap_response.get_json(silent=True) if hasattr(heatmap_response, "get_json") else None
        rows = (heatmap_response or {}).get("rows") or []
        target_row = next((row for row in rows if normalize_ticker(row.get("symbol")) == requested), None)
        target_in_heatmap = target_row is not None
        provider_sector = (target_row or {}).get("sector")
        target_metadata = _heatmap_sector_metadata(requested)
        if target_row is None or _canonical_heatmap_sector((target_row or {}).get("sector")).casefold() not in SECTOR_RELATION_ETFS:
            # TradingView also uses narrower industry groups, such as Electronic
            # Technology. Resolve the ETF sector from actual company metadata.
            if _canonical_heatmap_sector(target_metadata.get("sector")) == "Other" and sector_hint != "Other":
                target_metadata = {**target_metadata, "sector": sector_hint}
            if target_row is None and target_metadata:
                # A valid ticker can be outside the first 500 heat-map rows.
                target_row = {"symbol": requested, **target_metadata}
            elif target_row is not None and target_metadata:
                target_row = {**target_row, **target_metadata, "symbol": normalize_ticker(target_row.get("symbol"))}
            elif sector_hint != "Other":
                # The search page already resolved the sector from its quote
                # payload; use it when the provider metadata is rate-limited.
                if target_row is None:
                    target_row = {"symbol": requested, "name": requested, "sector": sector_hint}
                else:
                    target_row = {**target_row, "sector": sector_hint}
        if not rows and not target_row:
            return jsonify({"error": "Universo heat map temporaneamente non disponibile."}), 502
        if target_row is None:
            return jsonify({"error": "Settore del titolo non disponibile per il modello."}), 404
        target_symbol = normalize_ticker(target_row.get("symbol"))
        sector = _canonical_heatmap_sector(target_row.get("sector"))
        if sector == "Other":
            return jsonify({"error": "Settore del titolo non disponibile per il modello."}), 404
        sector_key = sector.casefold()
        peer_rows = sorted(
            [
                row for row in rows
                if (_canonical_heatmap_sector(row.get("sector")).casefold() == sector_key
                    or (provider_sector and str(row.get("sector") or "").strip() == provider_sector))
                and normalize_ticker(row.get("symbol")) != target_symbol
            ],
            key=lambda row: float(row.get("marketCap") or 0),
            reverse=True,
        )[:24]
        peer_symbols = [normalize_ticker(row.get("symbol")) for row in peer_rows if normalize_ticker(row.get("symbol"))]
        sector_etf = SECTOR_RELATION_ETFS.get(sector.casefold())
        sector_etfs = {label: symbol for label, symbol in {
            "Basic Materials": "XLB", "Communication Services": "XLC", "Consumer Cyclical": "XLY",
            "Consumer Defensive": "XLP", "Energy": "XLE", "Financial Services": "XLF",
            "Healthcare": "XLV", "Industrials": "XLI", "Real Estate": "XLRE",
            "Technology": "XLK", "Utilities": "XLU",
        }.items()}
        symbols = list(dict.fromkeys([target_symbol, *peer_symbols, *sector_etfs.values(), "SPY"]))
        histories = {}
        resolved_symbols = {}
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(_heatmap_relation_history, symbol): symbol for symbol in symbols}
            for future in as_completed(futures):
                symbol = futures[future]
                try:
                    history, resolved = future.result()
                except Exception:
                    history, resolved = pd.Series(dtype=float), None
                if isinstance(history, pd.Series) and not history.empty:
                    histories[symbol] = history
                    resolved_symbols[symbol] = resolved or symbol
        if target_symbol not in histories:
            return jsonify({"error": "Storico del titolo non disponibile per il modello."}), 502
        quote_currency = target_metadata.get("currency") or target_row.get("currency")
        currency, unit_scale = _heatmap_currency(quote_currency)
        cross_market = not target_in_heatmap or currency != "USD"
        fx_info = None
        currency_block = None
        warnings = []
        if not rows:
            warnings.append("Heatmap non disponibile: modello basato sui proxy settoriali, senza peer della heatmap.")
        if cross_market:
            warnings.append("Settori e mercato sono proxy USA, non indici del mercato locale. Le chiusure estere e il cambio usati nelle previsioni precedono la data del titolo (massimo 4 giorni).")
        if not currency:
            currency_block = "Valuta di quotazione non verificata: impossibile confrontare i rendimenti in modo affidabile."
        else:
            target_attrs = dict(histories[target_symbol].attrs)
            histories[target_symbol] = histories[target_symbol] * unit_scale
            histories[target_symbol].attrs = target_attrs
            if currency != "USD":
                fx, fx_info = _heatmap_usd_fx(currency)
                if fx_info is None:
                    currency_block = f"Cambio storico USD/{currency} non disponibile: confronto e segnale sospesi."
                else:
                    for symbol in list(histories):
                        if symbol != target_symbol:
                            histories[symbol] = _heatmap_convert_usd(histories[symbol], fx)
                    fx_info["method"] = "Prezzo USD × cambio storico; nessun riempimento dei cambi mancanti"
        if currency_block:
            # Do not show plausible-looking descriptive results in mixed currencies.
            histories = {target_symbol: histories[target_symbol]}
            warnings.append(currency_block)
        horizons = {"daily": 1, "monthly": 21, "annual": 252}
        peer_correlations = {key: [] for key in horizons}
        sector_correlations = {key: [] for key in horizons}
        models = {}
        signals = {}
        target_series = histories[target_symbol]
        peer_series = {symbol: histories[symbol] for symbol in peer_symbols if symbol in histories}
        signal_factors = {
            label: histories[symbol] for label, symbol in sector_etfs.items()
            if symbol in histories and histories[symbol].attrs.get("priceBasis") == "adjusted"
            and symbol != target_symbol
        }
        if "SPY" in histories and histories["SPY"].attrs.get("priceBasis") == "adjusted" and target_symbol != "SPY":
            signal_factors["Mercato · SPY"] = histories["SPY"]
        signal_sector = next((label for label, symbol in sector_etfs.items() if symbol == sector_etf), "Settore peer")
        adjusted_peers = {
            symbol: series.reindex(target_series.index).pct_change(fill_method=None)
            for symbol, series in peer_series.items() if series.attrs.get("priceBasis") == "adjusted"
        }
        if len(adjusted_peers) >= 2:
            peer_daily = pd.DataFrame(adjusted_peers)
            enough_peers = peer_daily.notna().sum(axis=1).ge(max(2, int(np.ceil(len(adjusted_peers) * 0.8))))
            basket = (1 + peer_daily.mean(axis=1).where(enough_peers)).cumprod() * 100
            signal_factors["Settore peer"] = basket
            if signal_sector not in signal_factors:
                signal_sector = "Settore peer"
        if cross_market:
            signal_factors = {name: _heatmap_prior_close(series, target_series.index)
                              for name, series in signal_factors.items()}
        signal_block = currency_block
        if target_series.attrs.get("priceBasis") != "adjusted":
            signal_block = "Prezzi rettificati del titolo non disponibili: split e dividendi impediscono una stima confrontabile."
        peer_sector_series = {}
        for key, lag in horizons.items():
            target_returns = _heatmap_relation_returns(target_series, lag)
            peer_returns = {symbol: _heatmap_relation_returns(series, lag) for symbol, series in peer_series.items()}
            for row in peer_rows:
                symbol = normalize_ticker(row.get("symbol"))
                if symbol not in peer_returns:
                    continue
                stats = _heatmap_pair_stats(target_returns, peer_returns[symbol], lag)
                stats.update({"symbol": symbol, "name": row.get("name") or symbol, "sector": sector, "marketCap": row.get("marketCap")})
                peer_correlations[key].append(stats)
            peer_correlations[key].sort(key=lambda item: abs(item.get("correlation") or 0), reverse=True)
            if peer_returns:
                peer_frame = pd.concat(peer_returns.values(), axis=1, join="outer").mean(axis=1, skipna=True).dropna()
                peer_sector_series[key] = peer_frame
            else:
                peer_sector_series[key] = pd.Series(dtype=float)
            factor_returns = {}
            if "SPY" in histories:
                factor_returns["Mercato · SPY"] = _heatmap_relation_returns(histories["SPY"], lag)
            if sector_etf and sector_etf in histories:
                factor_returns[sector] = _heatmap_relation_returns(histories[sector_etf], lag)
                if not peer_sector_series[key].empty:
                    # Keep a cross-sectional peer factor in addition to the
                    # ETF proxy, so the model also uses the actual heat-map
                    # constituents of the target's sector.
                    factor_returns[f"{sector} · peer average"] = peer_sector_series[key]
            elif not peer_sector_series[key].empty:
                factor_returns[f"{sector} · peer average"] = peer_sector_series[key]
            sector_reference_returns = factor_returns.get(sector)
            if sector_reference_returns is None or sector_reference_returns.empty:
                sector_reference_returns = peer_sector_series[key]
            for label, symbol in sector_etfs.items():
                # Exclude the own-sector ETF by symbol as well as by label:
                # TradingView may spell the same sector as "Health Care" or
                # "Healthcare", while both map to XLV.
                if symbol in histories and symbol != sector_etf:
                    factor_returns[label] = _heatmap_relation_returns(histories[symbol], lag)
                    # The sector table describes the relationship between the
                    # target's own sector factor and the other sector factors.
                    # The target's stock-level sensitivity is exposed separately
                    # through the ridge model below.
                    stats = _heatmap_pair_stats(sector_reference_returns, factor_returns[label], lag)
                    stats.update({"sector": label, "etf": symbol})
                    sector_correlations[key].append(stats)
            sector_correlations[key].sort(key=lambda item: abs(item.get("correlation") or 0), reverse=True)
            models[key] = _heatmap_relation_ridge(target_returns, factor_returns)
            if signal_block:
                signals[key] = unavailable_signal(key, "incompatible_data", signal_block, signal_cost_bps)
            else:
                signals[key] = build_heatmap_signal(target_series, signal_factors, key,
                                                   sector_factor=signal_sector, cost_bps=signal_cost_bps)
        result = _json_safe({
            "source": "TradingView heatmap + Yahoo Finance history",
            "target": {"symbol": target_symbol, "name": target_row.get("name") or target_symbol, "sector": sector, "marketCap": target_row.get("marketCap"), "currency": currency, "quoteCurrency": quote_currency, "inHeatmap": target_in_heatmap},
            "peerCount": len(peer_series),
            "peerUniverseCount": len(peer_symbols),
            "sectorReference": {
                "sector": sector,
                "etf": sector_etf if sector_etf in histories else None,
                "source": "sector ETF" if sector_etf in histories else "peer average",
            },
            "horizons": horizons,
            "peerCorrelations": peer_correlations,
            "sectorCorrelations": sector_correlations,
            "models": models,
            "signals": signals,
            "signalVersion": HEATMAP_SIGNAL_VERSION,
            "dataQuality": {
                "comparisonCurrency": currency,
                "fx": fx_info,
                "warnings": warnings,
                "foreignFeatureTiming": "prior-calendar-date-max-4-days" if cross_market else "same-market-close",
                "factorUniverse": "USA: ETF settoriali, SPY e peer della heatmap; non universo locale",
                "requestedSymbols": len(symbols),
                "availableHistories": len(histories),
                "resolvedSymbols": resolved_symbols,
                "lookback": "5y daily",
                "priceBasis": {symbol: series.attrs.get("priceBasis") for symbol, series in histories.items()},
                "signalFactorCount": len(signal_factors),
                "peerClassification": provider_sector or sector,
                "returnWindows": {"daily": "1 seduta", "monthly": "21 sedute", "annual": "252 sedute"},
            },
        })
        _cache_set(heatmap_relations_cache, cache_key, result, max_size=64)
        return jsonify(result)
    except Exception as exc:
        print("Errore heatmap relations:", exc)
        return jsonify({"error": "Modello delle relazioni non disponibile."}), 502


@app.route("/stock/<ticker>")
def get_stock(ticker):
    raw_ticker = ticker
    tf = request.args.get("timeframe", "1d")
    price_only = request.args.get("priceOnly", "false").lower() == "true"
    yf_interval = TF_MAPPING.get(tf, "1d")
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"v3:{cache_symbol}:{yf_interval}:priceOnly={price_only}"
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
            daily_data = safe_history(
                stock,
                period="2d",
                interval="1d",
                auto_adjust=False,
            )
            if daily_data.empty:
                daily_data = safe_history(
                    stock,
                    period="5d",
                    interval="1d",
                    auto_adjust=False,
                )
            if daily_data.empty:
                daily_data = safe_history(
                    stock,
                    period="1mo",
                    interval="1d",
                    auto_adjust=False,
                )
            if daily_data.empty:
                daily_data = safe_download(
                    cand,
                    period="1mo",
                    interval="1d",
                    auto_adjust=False,
                    progress=False,
                    threads=False,
                )
            if daily_data.empty:
                daily_data, chart_meta = _fetch_chart_data(cand, "5d", "1d")
            if not daily_data.empty:
                ticker = cand
                break

        if daily_data.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404

        daily_data, latest_chart_meta = _fetch_latest_daily_market_data(
            ticker,
            daily_data,
        )
        if latest_chart_meta:
            chart_meta = {**chart_meta, **latest_chart_meta}

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

        price_details = _price_metadata(daily_data, chart_meta)
        current_price = price_details["currentPrice"]
        daily_low = price_details["dailyLow"]
        daily_high = price_details["dailyHigh"]
        daily_change = price_details["dailyChange"]

        if price_only:
            payload = _json_safe({
                "info": {
                    **price_details,
                    "currency": chart_meta.get("currency"),
                }
            })
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
        if yf_interval == "1d":
            hist = _merge_daily_market_data(hist, daily_data)
        if hist.empty:
            # Fallback finale: usa daily_data per evitare 404 in frontend
            hist = daily_data.copy()
            if yf_interval == "1wk":
                hist = _resample_ohlc(hist, "W-FRI")
            elif yf_interval == "1mo":
                hist = _resample_ohlc(hist, "ME")
        hist = _prepare_ohlc_df(hist, require_complete=True)
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
            if not info.get("currency") and chart_meta.get("currency"):
                info["currency"] = chart_meta.get("currency")

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
            "shortName", "sector", "currency"
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

        # Le metriche di performance devono essere sempre calcolate su chiusure
        # giornaliere aggiustate, indipendentemente dal timeframe scelto nel grafico.
        analytics_hist = _fetch_analytics_history(ticker, stock, period="6y")

        last_volume = None
        if "Volume" in daily_data.columns and not daily_data.empty:
            try:
                last_volume = float(daily_data["Volume"].iloc[-1])
            except Exception:
                last_volume = None

        avg_volume_calc = None
        if "Volume" in analytics_hist.columns and not analytics_hist.empty:
            try:
                avg_volume_calc = float(
                    pd.to_numeric(analytics_hist["Volume"], errors="coerce").tail(30).mean()
                )
            except Exception:
                avg_volume_calc = None
        elif "Volume" in daily_data.columns and not daily_data.empty:
            try:
                avg_volume_calc = float(daily_data["Volume"].tail(30).mean())
            except Exception:
                avg_volume_calc = None

        year_hist = safe_history(stock, period="1y", interval="1d", auto_adjust=False)
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

        pe_ratio = pick(info.get("trailingPE"))
        if pe_ratio is None and trailing_eps and trailing_eps > 0:
            pe_ratio = round(current_price / trailing_eps, 2)
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

        benchmark_symbol = _benchmark_for_ticker(ticker)
        beta = info.get("beta")
        beta_benchmark = None
        beta_source = "provider" if beta is not None else None
        if beta is None:
            try:
                t_hist_beta = analytics_hist.tail(260)
                benchmark_stock = yf.Ticker(benchmark_symbol)
                m_hist = _fetch_analytics_history(
                    benchmark_symbol,
                    benchmark_stock,
                    period="2y",
                ).tail(260)
                if not t_hist_beta.empty and not m_hist.empty:
                    t_ret = t_hist_beta["Close"].pct_change().dropna()
                    m_ret = m_hist["Close"].pct_change().dropna()
                    t_ret, m_ret = t_ret.align(m_ret, join="inner")
                    if len(t_ret) > 10 and m_ret.var() > 0:
                        beta = round(t_ret.cov(m_ret) / m_ret.var(), 2)
                        beta_benchmark = benchmark_symbol
                        beta_source = "calculated"
            except Exception:
                beta = None

        # aggiorna info per coerenza
        if beta is not None:
            info["beta"] = beta
        if market_cap is not None:
            info["marketCap"] = market_cap
        if avg_volume is not None:
            info["averageVolume"] = avg_volume

        chart_tail_limit = {
            "60m": 480,
            "240m": 240,
            "1d": 260,
            "1wk": 260,
            "1mo": 240,
        }.get(yf_interval, 260)
        chart_hist = hist.tail(chart_tail_limit)
        ohlc_data = [
            {
                "date": idx.strftime("%Y-%m-%d %H:%M") if "m" in yf_interval else idx.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 6),
                "high": round(float(row["High"]), 6),
                "low": round(float(row["Low"]), 6),
                "close": round(float(row["Close"]), 6)
            }
            for idx, row in chart_hist.iterrows()
        ]

        # Performance: prezzi adjusted giornalieri e finestre temporali reali.
        if not analytics_hist.empty:
            close_series = pd.to_numeric(
                analytics_hist["Close"],
                errors="coerce",
            ).dropna()
            close_series = close_series[
                ~close_series.index.duplicated(keep="last")
            ].sort_index()
        else:
            close_series = pd.Series(dtype="float64")

        performance_history = [
            {
                "date": idx.strftime("%Y-%m-%d"),
                "close": round(float(value), 6),
            }
            for idx, value in close_series.items()
        ]

        def calc_period_return(offset):
            if len(close_series) < 2 or not isinstance(close_series.index, pd.DatetimeIndex):
                return None
            target_date = close_series.index[-1] - offset
            historical = close_series[close_series.index <= target_date]
            if historical.empty:
                return None
            old_price = float(historical.iloc[-1])
            latest_price = float(close_series.iloc[-1])
            if old_price <= 0:
                return None
            return round(((latest_price / old_price) - 1) * 100, 2)

        daily_returns = close_series.pct_change().dropna()
        trading_days = 252

        def annualized_vol(returns):
            if returns is None or len(returns) < 2:
                return None
            return round(returns.std() * np.sqrt(trading_days) * 100, 2)

        volatility = annualized_vol(daily_returns)
        volatility_30d = annualized_vol(daily_returns.tail(30)) if len(daily_returns) >= 30 else None

        if len(close_series) >= 2 and isinstance(close_series.index, pd.DatetimeIndex):
            one_year_start = close_series.index[-1] - pd.DateOffset(years=1)
            returns_1y = daily_returns[daily_returns.index >= one_year_start]
            prices_1y = close_series[close_series.index >= one_year_start]
        else:
            returns_1y = pd.Series(dtype="float64")
            prices_1y = pd.Series(dtype="float64")

        volatility_1y = annualized_vol(returns_1y)

        max_drawdown_1y = None
        if len(prices_1y) >= 2:
            roll_max = prices_1y.cummax()
            drawdown = (prices_1y / roll_max) - 1
            max_drawdown_1y = round(drawdown.min() * 100, 2)

        try:
            risk_free_rate = float(os.environ.get("SEARCH_RISK_FREE_RATE", "0"))
            if not np.isfinite(risk_free_rate) or risk_free_rate <= -1:
                risk_free_rate = 0.0
        except (TypeError, ValueError):
            risk_free_rate = 0.0
        daily_risk_free_rate = (1 + risk_free_rate) ** (1 / trading_days) - 1
        excess_returns_1y = returns_1y - daily_risk_free_rate

        sharpe_ratio = None
        if len(excess_returns_1y) >= 2:
            returns_std = returns_1y.std()
            if returns_std and returns_std > 0:
                sharpe_ratio = round(
                    (excess_returns_1y.mean() / returns_std) * np.sqrt(trading_days),
                    2,
                )

        sortino_ratio = None
        if len(excess_returns_1y) >= 2:
            downside_returns = np.minimum(excess_returns_1y, 0)
            downside_deviation = (
                np.sqrt(np.mean(np.square(downside_returns))) * np.sqrt(trading_days)
            )
            if downside_deviation and downside_deviation > 0:
                annualized_excess_return = excess_returns_1y.mean() * trading_days
                sortino_ratio = round(
                    annualized_excess_return / downside_deviation,
                    2,
                )

        performance = {
            "return1Y": calc_period_return(pd.DateOffset(years=1)),
            "return3Y": calc_period_return(pd.DateOffset(years=3)),
            "return5Y": calc_period_return(pd.DateOffset(years=5)),
            "volatility": volatility,
            "momentum1M": calc_period_return(pd.DateOffset(months=1)),
            "momentum3M": calc_period_return(pd.DateOffset(months=3)),
            "volatility30D": volatility_30d,
            "volatility1Y": volatility_1y,
            "maxDrawdown1Y": max_drawdown_1y,
            "sharpeRatio": sharpe_ratio,
            "sortinoRatio": sortino_ratio,
            "riskFreeRate": round(risk_free_rate * 100, 4),
        }

        # --- Risk index (composite) ---
        def _to_num(v):
            try:
                return float(v) if v is not None else None
            except Exception:
                return None

        def _clamp01(v):
            return max(0.0, min(1.0, v))

        vol1y = _to_num(performance.get("volatility1Y"))
        vol30 = _to_num(performance.get("volatility30D"))
        drawdown = _to_num(performance.get("maxDrawdown1Y"))
        beta = _to_num(info.get("beta"))
        sharpe = _to_num(performance.get("sharpeRatio"))
        sortino = _to_num(performance.get("sortinoRatio"))
        avg_volume_num = _to_num(avg_volume) or _to_num(volume)
        market_cap_num = _to_num(market_cap)
        avg_traded_value = None
        if avg_volume_num is not None and current_price is not None:
            avg_traded_value = avg_volume_num * current_price
        vol_regime = vol30 / vol1y if (vol30 is not None and vol1y is not None and vol1y > 0) else None

        vol_score = _clamp01((vol1y - 15) / 25) if vol1y is not None else None
        vol30_score = _clamp01((vol30 - 15) / 25) if vol30 is not None else None
        dd_score = _clamp01((abs(drawdown) - 10) / 25) if drawdown is not None else None
        beta_score = _clamp01((beta - 0.9) / 0.6) if beta is not None else None
        sharpe_score = _clamp01((1.2 - sharpe) / 1.2) if sharpe is not None else None
        sortino_score = _clamp01((1.4 - sortino) / 1.4) if sortino is not None else None

        regime_score = _clamp01((vol_regime - 1) / 0.6) if vol_regime is not None else None

        # La versione v2 usa soltanto misure indipendenti dalla valuta.
        # Liquidita' e capitalizzazione restano informative ma non alterano il punteggio.
        parts = [
            (vol_score, 0.25),
            (vol30_score, 0.10),
            (dd_score, 0.25),
            (beta_score, 0.10),
            (sharpe_score, 0.10),
            (sortino_score, 0.10),
            (regime_score, 0.10),
        ]
        parts = [(v, w) for v, w in parts if v is not None]
        if parts:
            weight_sum = sum(w for _, w in parts)
            risk_index = round((sum(v * w for v, w in parts) / weight_sum) * 100)
            risk_coverage = round(weight_sum * 100)
        else:
            risk_index = None
            risk_coverage = 0

        if risk_index is None:
            risk_level = "N/D"
        elif risk_index >= 67:
            risk_level = "Alto"
        elif risk_index >= 34:
            risk_level = "Medio"
        else:
            risk_level = "Basso"

        risk = {
            "version": "v2",
            "methodology": "Indice proprietario basato su volatilita, drawdown, beta e rendimenti corretti per il rischio.",
            "level": risk_level,
            "index": risk_index,
            "coverage": risk_coverage,
            "metrics": {
                "vol1y": vol1y,
                "vol30": vol30,
                "drawdown": drawdown,
                "beta": beta,
                "sharpe": sharpe,
                "sortino": sortino,
                "avgTradedValue": avg_traded_value,
                "avgVolume": avg_volume_num,
                "marketCap": market_cap_num,
                "volRegime": vol_regime,
                "benchmarkSymbol": beta_benchmark,
                "betaSource": beta_source,
                "riskFreeRate": performance.get("riskFreeRate"),
            }
        }

        currency = str(
            pick(
                fast_info.get("currency"),
                info.get("currency"),
                chart_meta.get("currency"),
            )
            or ""
        ).strip()

        response = _json_safe({
            "info": {
                "shortName": info.get("shortName") or ticker.upper(),
                "sector": info.get("sector") or "N/A",
                "currency": currency or None,
                "currentPrice": current_price,
                "previousClose": price_details["previousClose"],
                "dailyLow": daily_low,
                "dailyHigh": daily_high,
                "dailyOpen": price_details["dailyOpen"],
                "dailyChange": daily_change,
                "priceDate": price_details["priceDate"],
                "priceTimestamp": price_details["priceTimestamp"],
                "priceSource": price_details["priceSource"],
                "marketState": price_details["marketState"],
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
            "performanceHistory": performance_history,
            "performance": performance,
            "risk": risk
        })

        stock_response_cache[cache_key] = (response, datetime.utcnow())
        return jsonify(response)

    except Exception as e:
        print("ERRORE BACKEND:", e)
        return jsonify({"error": "Errore Server"}), 500


@app.route("/stock/<ticker>/financials")
def get_stock_financials(ticker):
    raw_ticker = ticker
    frequency = (request.args.get("frequency") or "annual").strip().lower()
    if frequency not in {"annual", "quarterly"}:
        return jsonify({"error": "Frequenza non valida"}), 400

    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"{cache_symbol}:{frequency}"
    cached = _cache_get(financials_cache, cache_key, FINANCIALS_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)

    try:
        selected_symbol = None
        dated_values = {}
        trailing_values = {}
        for candidate in ticker_candidates(raw_ticker):
            candidate_values, candidate_trailing = _fetch_financial_timeseries(
                candidate,
                frequency,
            )
            if candidate_values:
                selected_symbol = candidate
                dated_values = candidate_values
                trailing_values = candidate_trailing
                break

        if not selected_symbol:
            return jsonify({"error": "Dati di bilancio non disponibili"}), 404

        statements = _serialize_financial_statements(
            dated_values,
            trailing_values,
            frequency,
        )
        if not any(statement["rows"] for statement in statements.values()):
            return jsonify({"error": "Dati di bilancio non disponibili"}), 404

        _, chart_meta = _fetch_chart_data(selected_symbol, "5d", "1d")
        chart_meta = chart_meta or {}
        quote_fields = _fetch_quote_fields(selected_symbol)
        official_filings = _fetch_sec_filings(selected_symbol)

        current_price = _financial_number(
            chart_meta.get("regularMarketPrice")
            or quote_fields.get("regularMarketPrice")
        )
        previous_close = _financial_number(
            chart_meta.get("previousClose")
            or chart_meta.get("chartPreviousClose")
            or quote_fields.get("regularMarketPreviousClose")
        )
        daily_change = None
        if current_price is not None and previous_close not in (None, 0):
            daily_change = round(
                ((current_price / previous_close) - 1) * 100,
                2,
            )

        payload = {
            "symbol": selected_symbol,
            "frequency": frequency,
            "unit": "thousands",
            "currency": (
                chart_meta.get("currency")
                or quote_fields.get("currency")
                or None
            ),
            "quote": {
                "shortName": (
                    chart_meta.get("shortName")
                    or chart_meta.get("longName")
                    or quote_fields.get("shortName")
                    or selected_symbol
                ),
                "exchange": (
                    chart_meta.get("fullExchangeName")
                    or chart_meta.get("exchangeName")
                    or ""
                ),
                "currentPrice": current_price,
                "dailyChange": daily_change,
            },
            "statements": statements,
            "officialFilings": official_filings,
            "dataProvenance": {
                "statementPrimary": "Yahoo Finance",
                "statementFallback": (
                    "SEC Company Facts"
                    if official_filings.get("cik")
                    else None
                ),
                "filingsProvider": "SEC EDGAR",
                "method": (
                    "I valori Yahoo disponibili hanno priorità; SEC Company "
                    "Facts completa solo voci o esercizi annuali mancanti."
                ),
            },
        }
        _cache_set(financials_cache, cache_key, payload, max_size=160)
        return jsonify(payload)
    except Exception as exc:
        print("Errore dati bilancio:", exc)
        return jsonify({"error": "Errore durante il caricamento del bilancio"}), 500


@app.route("/stock/<ticker>/fundamental-return-forecast")
def get_fundamental_return_forecast(ticker):
    """Previsione ML da filing SEC point-in-time per 1, 3 e 12 mesi."""

    artifact = _load_fundamental_model_artifact()
    if artifact is None:
        return jsonify(
            {
                "status": "unavailable",
                "error": "Modello fondamentale non ancora addestrato.",
                "reason": (
                    "Esegui backend/train_fundamental_model.py per creare un "
                    "artifact validato temporalmente."
                ),
            }
        ), 503

    cache_symbol = (ticker or "").strip().upper().replace(" ", "")
    model_cache_key = (
        f"{cache_symbol}:"
        f"{artifact.get('modelVersion') or 'unknown'}:"
        f"{artifact.get('generatedAt') or 'unknown'}"
    )
    cached = _cache_get(
        fundamental_forecast_cache,
        model_cache_key,
        FUNDAMENTAL_FORECAST_CACHE_TTL,
    )
    if cached is not None:
        return jsonify(cached)

    try:
        dataset_metadata = artifact.get("dataset", {}) or {}
        filing_policy = dataset_metadata.get("filingPolicy", {}) or {}
        target_policy = dataset_metadata.get("targetPolicy", {}) or {}
        now = datetime.utcnow()
        security_row, has_runtime_security_master = _resolve_artifact_security(
            artifact,
            cache_symbol,
            now,
        )
        if has_runtime_security_master and security_row is None:
            return jsonify(
                {
                    "status": "unavailable",
                    "symbol": cache_symbol,
                    "error": "Titolo non presente nel security master del modello.",
                    "reason": (
                        "L'inferenza è sospesa per evitare survivorship bias o "
                        "l'uso di un ticker fuori dal relativo intervallo storico."
                    ),
                }
            ), 422
        filing_frequency = str(
            filing_policy.get("frequency") or "annual"
        ).strip().lower()
        include_quarterly = filing_frequency == "quarterly"
        target_kind = str(target_policy.get("selected") or "raw").strip().lower()
        selected_symbol = None
        companyfacts = {}
        submissions = {}
        vintages = []
        runtime_candidates = []
        if security_row:
            runtime_candidates.extend(
                [
                    security_row.get("price_ticker"),
                    security_row.get("ticker"),
                    security_row.get("current_ticker"),
                    security_row.get("canonical_ticker"),
                ]
            )
        candidate_symbols = []
        for candidate in [*runtime_candidates, *ticker_candidates(ticker)]:
            normalized_candidate = str(candidate or "").strip().upper()
            if normalized_candidate and normalized_candidate not in candidate_symbols:
                candidate_symbols.append(normalized_candidate)
        for candidate in candidate_symbols:
            candidate_companyfacts = _fetch_sec_companyfacts_payload(candidate)
            candidate_submissions = _fetch_sec_submissions_payload(candidate)
            filing_index = build_ml_filing_index(
                candidate_submissions,
                include_quarterly=include_quarterly,
            )
            candidate_vintages = (
                extract_ml_filing_vintages(
                    candidate_companyfacts,
                    filing_index,
                    include_quarterly=True,
                )
                if include_quarterly
                else extract_ml_annual_vintages(
                    candidate_companyfacts,
                    filing_index,
                )
            )
            if candidate_vintages:
                selected_symbol = candidate
                companyfacts = candidate_companyfacts
                submissions = candidate_submissions
                vintages = candidate_vintages
                break

        if not selected_symbol:
            return jsonify(
                {
                    "status": "unavailable",
                    "symbol": cache_symbol,
                    "error": "Filing SEC point-in-time non disponibili.",
                    "reason": (
                        "La prima versione copre emittenti statunitensi con "
                        + (
                            "filing 10-K/10-Q US-GAAP."
                            if include_quarterly
                            else "filing 10-K US-GAAP."
                        )
                    ),
                }
            ), 404

        try:
            sic = int(submissions.get("sic"))
        except (TypeError, ValueError):
            sic = None
        if sic is not None and 6000 <= sic <= 6799:
            return jsonify(
                {
                    "status": "unavailable",
                    "symbol": selected_symbol,
                    "error": "Modello non applicabile a questo settore.",
                    "reason": (
                        "Banche, assicurazioni, fondi e REIT richiedono "
                        "feature contabili e un modello dedicati."
                    ),
                }
            ), 422

        current_vintage, previous_vintage = latest_ml_usable_vintage(vintages)
        if current_vintage is None:
            return jsonify(
                {
                    "status": "unavailable",
                    "symbol": selected_symbol,
                    "error": "Nessun filing utilizzabile alla data odierna.",
                }
            ), 404

        chart, chart_meta = _fetch_chart_data(selected_symbol, "1mo", "1d")
        chart_meta = chart_meta or {}
        quote_fields = _fetch_quote_fields(selected_symbol)
        raw_price = _financial_number(chart_meta.get("regularMarketPrice"))
        price_source = "Yahoo Finance"
        price_as_of = None
        if raw_price is None:
            raw_price = _financial_number(
                quote_fields.get("regularMarketPrice")
            )
        if raw_price is None and not chart.empty:
            raw_price = _financial_number(chart["Close"].iloc[-1])
        if raw_price is not None and not chart.empty:
            try:
                price_as_of = pd.Timestamp(chart.index[-1]).date().isoformat()
            except (TypeError, ValueError):
                price_as_of = None
        if raw_price is None:
            raw_price, price_as_of = _latest_fundamental_training_price(
                selected_symbol
            )
            if raw_price is not None:
                price_source = "Cache locale del training"
        if raw_price is None or raw_price <= 0:
            return jsonify(
                {
                    "status": "unavailable",
                    "symbol": selected_symbol,
                    "error": "Prezzo corrente non disponibile per l'inferenza.",
                }
            ), 503

        filing_age_days = max(0, (now - current_vintage["acceptedAt"]).days)
        current_form = str(current_vintage.get("form") or "").upper()
        is_quarterly_filing = current_form == "10-Q"
        stale_warning_days = 190 if is_quarterly_filing else 400
        stale_limit_days = 280 if is_quarterly_filing else 550
        features = build_feature_vector(
            current_vintage["metrics"],
            (
                previous_vintage["metrics"]
                if previous_vintage is not None
                else None
            ),
            raw_price=raw_price,
            filing_age_days=filing_age_days,
        )
        runtime_features, runtime_feature_audit = _build_runtime_v5_features(
            artifact,
            selected_symbol,
            quote_fields,
            chart_meta,
            submissions,
            security_row,
            now,
        )
        features.update(runtime_features)
        inference = predict_from_artifact(artifact, features)
        out_of_distribution = _fundamental_model_ood(features, artifact)
        coverage = (
            inference.get("dataQuality", {}).get("featureCoveragePct")
            or 0
        )
        warnings = []
        warning_objects = []

        def add_forecast_warning(
            code,
            title,
            detail,
            *,
            horizons=None,
            severity="warning",
        ):
            warnings.append(detail)
            warning_objects.append(
                {
                    "code": code,
                    "severity": severity,
                    "title": title,
                    "detail": detail,
                    "horizons": list(horizons or []),
                }
            )

        if filing_age_days > stale_warning_days:
            add_forecast_warning(
                "stale-filing",
                "Filing datato",
                f"Il filing {current_form or 'usato'} ha più di "
                f"{stale_warning_days} giorni: i fondamentali sono datati.",
            )
        if coverage < 65:
            add_forecast_warning(
                "low-feature-coverage",
                "Copertura feature limitata",
                "Copertura delle feature inferiore al 65%: stima più fragile."
            )
        missing_runtime_features = runtime_feature_audit.get(
            "missingRequiredFeatures", []
        )
        if missing_runtime_features:
            add_forecast_warning(
                "missing-v5-features",
                "Feature market/event incomplete",
                f"{len(missing_runtime_features)} feature v5 richieste non sono "
                "disponibili con un timestamp verificabile; il modello usa "
                "missingness esplicita.",
            )
        if (
            runtime_feature_audit.get("enabled")
            and not has_runtime_security_master
            and runtime_feature_audit.get("requiredCategoricalFeatures")
        ):
            add_forecast_warning(
                "unverified-live-security-classification",
                "Classificazione security master non verificata",
                "Settore e classificazione live provengono dai metadati correnti; "
                "l'artifact non incorpora un security master storico portabile.",
            )
        if out_of_distribution:
            add_forecast_warning(
                "out-of-distribution",
                "Dati fuori distribuzione",
                f"{len(out_of_distribution)} feature sono fuori dal range "
                "1°-99° percentile osservato nel training.",
            )
        runtime_fallbacks = (
            inference.get("dataQuality", {}).get("runtimeFallbacks") or []
        )
        if runtime_fallbacks:
            add_forecast_warning(
                "runtime-fallback",
                "Fallback del modello",
                "Il challenger selezionato non era caricabile nel runtime: "
                "è stato usato il fallback Ridge per gli orizzonti indicati.",
                horizons=[
                    item.get("horizon")
                    for item in runtime_fallbacks
                    if item.get("horizon")
                ],
            )
        prospective_horizons = []
        for horizon, model in (artifact.get("models") or {}).items():
            selection = (
                model.get("selection")
                if isinstance(model, dict)
                else {}
            ) or {}
            if (
                selection.get("rankIcTradeoffApplied")
                and selection.get("policyValidationStatus")
                == "prospective-confirmation-required"
            ):
                horizon_metadata = (
                    artifact.get("horizons", {}).get(horizon, {})
                )
                prospective_horizons.append(
                    horizon_metadata.get("label") or horizon
                )
        if prospective_horizons:
            add_forecast_warning(
                "prospective-confirmation",
                "Conferma prospettica richiesta",
                "La promozione basata sulla nuova regola relativa del Rank IC "
                "è esplorativa per: "
                + ", ".join(prospective_horizons)
                + ". Richiede conferma su una finestra futura mai osservata.",
                horizons=prospective_horizons,
            )
        validation_statuses = {}
        for prediction in inference.get("predictions", []):
            validation_status = (
                prediction.get("validationStatus")
                or (prediction.get("performance") or {}).get("validationStatus")
            )
            if validation_status and prediction.get("horizon"):
                validation_statuses.setdefault(validation_status, []).append(
                    prediction["horizon"]
                )
        prospective_status_horizons = validation_statuses.get(
            "prospectiveConfirmationRequired",
            [],
        )
        if prospective_status_horizons and not prospective_horizons:
            add_forecast_warning(
                "prospective-confirmation",
                "Conferma prospettica richiesta",
                "La selezione è esplorativa finché non matura una finestra "
                "futura mai osservata.",
                horizons=prospective_status_horizons,
            )
        if validation_statuses.get("holdoutNotConfirmed"):
            add_forecast_warning(
                "holdout-not-confirmed",
                "Holdout finale non confermato",
                "Il segnale osservato nello sviluppo non è stato confermato "
                "nella finestra temporale finale.",
                horizons=validation_statuses["holdoutNotConfirmed"],
            )
        if validation_statuses.get("legacyArtifact"):
            add_forecast_warning(
                "legacy-validation",
                "Validazione precedente alla v4",
                "L'artifact attivo non contiene ancora IC cross-sectional, "
                "bootstrap a blocchi e robustezza non-overlapping.",
                horizons=validation_statuses["legacyArtifact"],
            )
        if price_source == "Cache locale del training":
            add_forecast_warning(
                "stale-price",
                "Prezzo live non disponibile",
                "Prezzo live non disponibile: per le feature di valutazione "
                "è stata usata l'ultima chiusura presente nella cache locale.",
            )
        unpublished_horizons = [
            prediction.get("horizon")
            for prediction in inference.get("predictions", [])
            if not prediction.get("publishable") and prediction.get("horizon")
        ]
        if unpublished_horizons:
            add_forecast_warning(
                "baseline-not-beaten",
                "Baseline non superata",
                "Uno o più orizzonti non hanno superato la baseline nulla "
                "nel backtest walk-forward.",
                horizons=unpublished_horizons,
            )
        undercovered_intervals = [
            prediction.get("horizon")
            for prediction in inference.get("predictions", [])
            if _financial_number(
                (prediction.get("performance") or {}).get(
                    "interval80CoveragePct"
                )
            )
            is not None
            and float(
                prediction["performance"]["interval80CoveragePct"]
            )
            < 75.0
        ]
        if undercovered_intervals:
            add_forecast_warning(
                "interval-undercoverage",
                "Intervallo sottocalibrato",
                "L'intervallo nominale all'80% ha coperto meno del 75% "
                "dell'holdout per: "
                + ", ".join(undercovered_intervals)
                + ".",
                horizons=undercovered_intervals,
            )
        if current_vintage.get("acceptanceFallback"):
            add_forecast_warning(
                "filing-time-fallback",
                "Ora del filing stimata",
                "Ora di accettazione non disponibile: è stata usata la fine "
                "del giorno di deposito come stima conservativa.",
            )

        cik_value = submissions.get("cik") or companyfacts.get("cik")
        try:
            cik = f"{int(cik_value):010d}"
        except (TypeError, ValueError):
            cik = None
        accession = current_vintage.get("accessionNumber")
        filing_url = None
        if cik and accession:
            filing_url = (
                "https://www.sec.gov/Archives/edgar/data/"
                f"{int(cik)}/{str(accession).replace('-', '')}/"
                f"{accession}-index.html"
            )

        status = inference.get("status") or "limited"
        if filing_age_days > stale_limit_days or coverage < 45:
            status = "limited"
        payload = _json_safe(
            {
                "status": status,
                "symbol": selected_symbol,
                "companyName": (
                    submissions.get("name")
                    or companyfacts.get("entityName")
                    or selected_symbol
                ),
                "modelVersion": artifact.get("modelVersion"),
                "modelAsOf": artifact.get("generatedAt"),
                "modelSummary": artifact.get("modelSummary", {}),
                "predictions": inference.get("predictions", []),
                "drivers": inference.get("drivers", {}),
                "driversByHorizon": inference.get("driversByHorizon", {}),
                "dataQuality": {
                    **inference.get("dataQuality", {}),
                    "outOfDistributionFeatures": out_of_distribution,
                    "runtimeFeatureAudit": runtime_feature_audit,
                    "filingMetricCoveragePct": (
                        float(current_vintage.get("metricCoverage") or 0) * 100
                    ),
                    "priceSource": price_source,
                    "priceAsOf": price_as_of,
                    "warnings": warnings,
                    "warningObjects": warning_objects,
                },
                "filing": {
                    "form": current_vintage.get("form"),
                    "frequency": (
                        current_vintage.get("filingFrequency")
                        or ("quarterly" if is_quarterly_filing else "annual")
                    ),
                    "reportDate": current_vintage.get("reportDate"),
                    "acceptedAt": current_vintage.get("acceptedAtIso"),
                    "accessionNumber": accession,
                    "filingAgeDays": filing_age_days,
                    "url": filing_url,
                },
                "dataset": {
                    "rows": artifact.get("dataset", {}).get("rows"),
                    "issuers": artifact.get("dataset", {}).get("issuers"),
                    "algorithmsEvaluated": artifact.get("dataset", {}).get(
                        "algorithmsEvaluated",
                        [],
                    ),
                    "trainingEnd": max(
                        (
                            model.get("trainingEnd") or ""
                            for model in artifact.get("models", {}).values()
                        ),
                        default=None,
                    ),
                    "targetLabel": (
                        artifact.get("dataset", {}).get("targetLabel")
                        or artifact.get("methodology", {}).get("target")
                    ),
                    "targetKind": target_kind,
                    "targetBenchmarks": target_policy.get("benchmarks", {}),
                    "securityMaster": dataset_metadata.get(
                        "universeAudit", {}
                    ),
                    "filingFrequency": filing_frequency,
                    "validationVersion": artifact.get("validationVersion"),
                },
                "methodology": artifact.get("methodology", {}),
                "limitations": artifact.get("dataset", {}).get(
                    "knownLimitations",
                    [],
                ),
                "disclaimer": (
                    "Stima probabilistica di ricerca, non una certezza né una "
                    "raccomandazione di acquisto o vendita."
                ),
            }
        )
        _cache_set(
            fundamental_forecast_cache,
            model_cache_key,
            payload,
            max_size=160,
        )
        return jsonify(payload)
    except Exception as exc:
        print("Errore previsione fondamentale:", exc)
        return jsonify(
            {
                "status": "unavailable",
                "symbol": cache_symbol,
                "error": "Errore durante la previsione fondamentale.",
            }
        ), 500


# -------------------------------
# Ricerca quantitativa avanzata
# -------------------------------
@app.route("/stock/<ticker>/quantitative-research")
def get_quantitative_research(ticker):
    symbol = (ticker or "").strip().upper().replace(" ", "")
    artifact = _load_fundamental_model_artifact() or {}
    cache_key = f"{symbol}:{artifact.get('modelVersion') or 'none'}"
    cached = _cache_get(quantitative_research_cache, cache_key, QUANTITATIVE_RESEARCH_CACHE_TTL)
    if cached is not None:
        return jsonify(cached)
    try:
        chart, _meta = _fetch_chart_data(symbol, "5y", "1d")
        returns = []
        if isinstance(chart, pd.DataFrame) and not chart.empty:
            column = "Adj Close" if "Adj Close" in chart.columns else "Close"
            prices = pd.to_numeric(chart[column], errors="coerce").dropna()
            returns = prices.pct_change().dropna().tolist()
        payload = build_quantitative_research_payload(
            artifact,
            symbol,
            returns=returns,
            dataset_path=os.environ.get("FUNDAMENTAL_DATASET_PATH"),
            security_master_path=os.environ.get("SECURITY_MASTER_PATH"),
            price_dir=os.environ.get("ML_PRICE_CACHE_DIR"),
        )
        _cache_set(quantitative_research_cache, cache_key, payload, max_size=80)
        return jsonify(payload)
    except Exception as exc:
        print("Errore ricerca quantitativa avanzata:", exc)
        return jsonify({"status": "unavailable", "symbol": symbol, "error": "Ricerca quantitativa avanzata non disponibile."}), 500


# -------------------------------
# Endpoint tecnici stile TradingView
# -------------------------------
@app.route("/stock/<ticker>/technicals")
def get_technicals(ticker):
    timeframe = request.args.get("timeframe", "1d")
    if timeframe not in TF_MAPPING:
        return jsonify({"error": "Timeframe non valido"}), 400
    interval = TF_MAPPING[timeframe]
    symbol = normalize_ticker(ticker)
    try:
        if timeframe == "1d":
            hist, symbol, meta = _load_page_daily_source(symbol)
            source_id = hist.attrs.get("pageSourceId", "")
        else:
            meta, hist = {}, pd.DataFrame()
            period, chart_range = ("60d", "60d") if interval.endswith("m") else ("5y", "10y") if interval == "1wk" else ("20y", "20y")
            source_id = f"{symbol}:{timeframe}"
            cached = _cache_get(technicals_cache, f"{PAGE_ENGINE_VERSION}:{source_id}", TECHNICALS_CACHE_TTL)
            if cached is not None:
                return jsonify(cached)
            for candidate in ticker_candidates(symbol):
                hist = _fetch_interval_history(candidate, yf.Ticker(candidate), period, interval, chart_range)
                if not hist.empty:
                    symbol = candidate
                    break
        if hist.empty:
            return jsonify({"error": "Nessun dato disponibile"}), 404
        cache_key = f"{PAGE_ENGINE_VERSION}:{source_id}"
        cached = _cache_get(technicals_cache, cache_key, TECHNICALS_CACHE_TTL)
        if cached is not None:
            return jsonify(cached)
        response = technical_page_payload(hist)
        response.update(symbol=symbol, timeframe=timeframe, currency=meta.get("currency"),
                        sourceId=source_id, completedDaily=timeframe == "1d")
        response = _json_safe(response)
        _cache_set(technicals_cache, cache_key, response)
        return jsonify(response)
    except Exception as exc:
        print("Errore tecnici:", type(exc).__name__)
        return jsonify({"error": "Errore nel recupero dati tecnici"}), 500


# Endpoint notizie Yahoo Finance RSS
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
    exclude_outliers = request.args.get("exclude_outliers", "false").lower() == "true"
    prior_years_only = request.args.get("prior_years_only", "false").lower() == "true"
    try:
        daily, symbol, meta = _load_page_daily_source(ticker)
        if daily.empty or len(daily) < 120:
            return jsonify({"error": "Dati insufficienti"}), 404
        key = f"{PAGE_ENGINE_VERSION}:{daily.attrs['pageSourceId']}:{exclude_outliers}:{prior_years_only}"
        cached = _cache_get(seasonality_cache, key, SEASONALITY_CACHE_TTL)
        if cached is not None:
            return jsonify(cached)
        response = seasonality_page_payload(daily, exclude_outliers, daily.index[-1], prior_years_only)
        if not response["years"]:
            return jsonify({"error": "Dati stagionalita insufficienti"}), 404
        response.update(symbol=symbol, currency=meta.get("currency"), sourceId=daily.attrs["pageSourceId"])
        response = _json_safe(response)
        _cache_set(seasonality_cache, key, response, max_size=220)
        return jsonify(response)
    except Exception as exc:
        print("Errore stagionalita:", type(exc).__name__)
        return jsonify({"error": "Errore stagionalita"}), 500
    
# ---------------------- Supply/Demand Functions ----------------------

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
    requested_range = str(request.args.get("range") or "").strip().lower()
    allowed_daily_ranges = {"1y": 1, "2y": 2, "3y": 3, "5y": 5, "10y": 10}
    if requested_range not in allowed_daily_ranges:
        requested_range = ""
    cache_symbol = (raw_ticker or "").strip().upper().replace(" ", "")
    cache_key = f"v5:{cache_symbol}:{timeframe}:{requested_range or 'default'}"
    cached = _cache_get(history_cache, cache_key, HISTORY_CACHE_TTL)
    if isinstance(cached, dict) and isinstance(cached.get("history"), list) and cached["history"]:
        return jsonify(cached)
    try:
        yf_interval = TF_MAPPING.get(timeframe, "1d")
        generated_at = datetime.now(timezone.utc)
        today_utc = pd.Timestamp(generated_at).tz_localize(None).normalize()
        requested_cutoff = (
            today_utc - pd.DateOffset(years=allowed_daily_ranges[requested_range])
            if requested_range
            else None
        )

        if yf_interval == "1d":
            buffered_ranges = {
                "1y": "2y",
                "2y": "5y",
                "3y": "5y",
                "5y": "10y",
                "10y": "max",
            }
            period = buffered_ranges.get(requested_range, "6mo")
            chart_range = buffered_ranges.get(requested_range, "1y")
        elif yf_interval == "1wk":
            period = "5y"
            chart_range = "5y"
        elif yf_interval == "1mo":
            period = "20y"
            chart_range = "20y"
        else:
            period = "3mo"
            chart_range = "6mo"

        if yf_interval == "1mo":
            date_fmt = "%Y-%m"
        elif yf_interval.endswith("m"):
            date_fmt = "%Y-%m-%d %H:%M"
        else:
            date_fmt = "%Y-%m-%d"

        tail_map = {"1d": 120, "1w": 120, "1mo": 120}
        tail_limit = None if (yf_interval == "1d" and requested_range) else tail_map.get(timeframe, 120)

        hist = pd.DataFrame()
        stock = None
        excluded_current_session = False
        invalid_rows_removed = 0
        for cand in ticker_candidates(raw_ticker):
            stock = yf.Ticker(cand)
            hist = _fetch_interval_history(cand, stock, period, yf_interval, chart_range)
            try:
                candidate_invalid_rows_removed = max(
                    int(hist.attrs.get("invalidRowsRemoved", 0)),
                    0,
                )
            except (AttributeError, TypeError, ValueError):
                candidate_invalid_rows_removed = 0
            if yf_interval == "1d" and not requested_range and not hist.empty:
                hist, _ = _fetch_latest_daily_market_data(cand, hist)
            if (
                yf_interval == "1d"
                and requested_range
                and not hist.empty
                and isinstance(hist.index, pd.DatetimeIndex)
            ):
                # Una barra con data odierna puo essere ancora intraday. Senza
                # una conferma esplicita di chiusura la escludiamo dal campione.
                current_session_mask = hist.index.normalize() >= today_utc
                excluded_current_session = bool(current_session_mask.any())
                hist = hist.loc[~current_session_mask]
            if (
                yf_interval == "1d"
                and requested_range
                and not hist.empty
                and isinstance(hist.index, pd.DatetimeIndex)
            ):
                eligible_positions = np.flatnonzero(hist.index >= requested_cutoff)
                if eligible_positions.size:
                    first_position = int(eligible_positions[0])
                    # Conserva una chiusura precedente al cutoff: e il seed
                    # necessario per il primo rendimento giornaliero del range.
                    hist = hist.iloc[max(0, first_position - 1) :]
                else:
                    hist = hist.iloc[0:0]
            if tail_limit is not None:
                hist = hist.tail(tail_limit)
            if not hist.empty:
                ticker = cand
                invalid_rows_removed = candidate_invalid_rows_removed
                break
        if hist.empty:
            return jsonify({"history": [], "error": "Storico non disponibile"}), 404

        preparation_input_count = len(hist)
        hist = _prepare_ohlc_df(hist, require_complete=True)
        invalid_rows_removed = max(
            int(hist.attrs.get("invalidRowsRemoved", 0) or 0),
            invalid_rows_removed + max(preparation_input_count - len(hist), 0),
        )
        if hist.empty:
            return jsonify({"history": [], "error": "Storico non disponibile"}), 404

        def finite_history_value(value, default=0.0):
            numeric = _financial_number(value)
            return float(numeric) if numeric is not None else float(default)

        history_data = []
        for date, row in hist.iterrows():
            adjusted_close = (
                _financial_number(row.get("Adj Close"))
                if "Adj Close" in hist.columns
                else None
            )
            history_data.append(
                {
                    "date": date.strftime(date_fmt),
                    "open": round(float(row["Open"]), 2),
                    "high": round(float(row["High"]), 2),
                    "low": round(float(row["Low"]), 2),
                    "close": round(float(row["Close"]), 2),
                    "rawClose": round(float(row["Close"]), 6),
                    "adjustedClose": (
                        round(float(adjusted_close), 6)
                        if adjusted_close is not None
                        else None
                    ),
                    "volume": finite_history_value(row.get("Volume")),
                    "dividend": finite_history_value(row.get("Dividends")),
                    "stockSplit": finite_history_value(row.get("Stock Splits")),
                }
            )

        includes_previous_close = bool(
            requested_range
            and history_data
            and history_data[0]["date"] < requested_cutoff.date().isoformat()
        )
        observation_rows = (
            history_data[1:] if includes_previous_close else history_data
        )
        observation_count = len(observation_rows)
        adjusted_close_count = sum(
            row.get("adjustedClose") is not None for row in observation_rows
        )
        corporate_action_count = sum(
            int(row.get("dividend", 0.0) != 0.0)
            + int(row.get("stockSplit", 0.0) != 0.0)
            for row in observation_rows
        )
        payload = _json_safe(
            {
                "history": history_data,
                "range": requested_range or "default",
                "interval": timeframe,
                "rangeStart": (
                    requested_cutoff.date().isoformat()
                    if requested_range and not hist.empty
                    else None
                ),
                "rangeEnd": (
                    today_utc.date().isoformat() if requested_range else None
                ),
                "includesPreviousClose": includes_previous_close,
                "excludedPotentiallyIncompleteSession": excluded_current_session,
                "priceField": (
                    "adjustedClose"
                    if any(row.get("adjustedClose") is not None for row in history_data)
                    else "close"
                ),
                "requestedTicker": cache_symbol,
                "resolvedTicker": str(ticker or cache_symbol).strip().upper(),
                "generatedAt": (
                    generated_at.replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z")
                ),
                "dataSource": "Yahoo Finance",
                "observationCount": observation_count,
                "actualStart": (
                    observation_rows[0]["date"] if observation_rows else None
                ),
                "actualEnd": (
                    observation_rows[-1]["date"] if observation_rows else None
                ),
                "adjustedCloseCount": adjusted_close_count,
                "adjustedCloseCoveragePct": (
                    round((adjusted_close_count / observation_count) * 100, 2)
                    if observation_count
                    else 0.0
                ),
                "corporateActionCount": corporate_action_count,
                "invalidRowsRemoved": invalid_rows_removed,
            }
        )
        _cache_set(history_cache, cache_key, payload, max_size=320)
        return jsonify(payload)
    except Exception as e:
        print("Errore storico:", e)
        return jsonify({"history": [], "error": "Storico temporaneamente non disponibile"}), 503





    

if __name__ == "__main__":
    debug_env = os.environ.get("FLASK_DEBUG")
    debug_enabled = (
        debug_env.lower() in {"1", "true", "yes", "on"} if debug_env is not None else False
    )
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=debug_enabled,
        use_reloader=debug_enabled,
    )
