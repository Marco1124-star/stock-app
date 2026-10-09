"""Addestra offline il modello fondamentale point-in-time.

Esempio:
    python train_fundamental_model.py --limit 60

La pipeline scarica i filing SEC, conserva la vintage collegata allo specifico
accession e usa prezzi Yahoo rettificati esclusivamente per costruire i target.
L'API Flask non addestra mai il modello durante una richiesta.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta
import gzip
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence
import urllib.request

import pandas as pd
import yfinance as yf

from ml.fundamental_model import FEATURE_NAMES, HORIZONS, fit_artifact
from ml.point_in_time import (
    V5_CATEGORICAL_FEATURE_NAMES,
    V5_MARKET_FEATURE_NAMES,
    V5_MARKET_MISSING_FLAG_NAMES,
    audit_market_feature_leakage,
    build_filing_index,
    build_monthly_samples,
    extract_annual_vintages,
    extract_filing_vintages,
    resolve_security_point_in_time,
)


DEFAULT_UNIVERSE = [
    # Tecnologia e comunicazione
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "ORCL", "CRM",
    "ADBE", "CSCO", "QCOM", "TXN", "AMD", "INTU", "AMAT", "LRCX",
    "MU", "IBM", "NOW", "NFLX", "DIS", "CMCSA", "T", "VZ",
    # Industria e trasporti
    "CAT", "DE", "HON", "GE", "ETN", "UPS", "FDX", "LMT", "RTX",
    "NOC", "BA", "MMM", "EMR", "ITW",
    # Consumi
    "WMT", "COST", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "KO",
    "PEP", "PG", "CL", "KMB",
    # Salute
    "JNJ", "PFE", "MRK", "ABBV", "LLY", "AMGN", "GILD", "BMY", "MDT",
    "ABT", "TMO", "DHR", "ISRG",
    # Energia e materiali
    "XOM", "CVX", "COP", "SLB", "EOG", "OXY", "LIN", "APD", "SHW",
    "NEM", "FCX",
]

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CACHE_DIR = BASE_DIR / ".ml-cache"
DEFAULT_OUTPUT = BASE_DIR / "models" / "fundamental_return_model.json"


def _user_agent() -> str:
    return (
        os.environ.get("SEC_USER_AGENT")
        or "StockApp/1.0 local-research (configure SEC_USER_AGENT with contact)"
    ).strip()


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
    temporary.replace(path)


def _download_json(
    url: str,
    cache_path: Path,
    *,
    refresh: bool,
    offline: bool = False,
    timeout: int = 30,
) -> Dict[str, Any]:
    if cache_path.exists() and not refresh:
        cached = _read_json(cache_path)
        if cached:
            return cached
    if offline:
        raise FileNotFoundError(f"Cache JSON mancante in modalita offline: {cache_path}")
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": _user_agent(),
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        if str(response.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.decompress(raw)
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Risposta JSON non valida: {url}")
    _write_json_atomic(cache_path, payload)
    time.sleep(0.20)  # 5 richieste/s, sotto il limite SEC pubblicato.
    return payload


def _ticker_lookup(
    cache_dir: Path,
    refresh: bool,
    *,
    offline: bool = False,
) -> Dict[str, Dict[str, Any]]:
    payload = _download_json(
        "https://www.sec.gov/files/company_tickers.json",
        cache_dir / "company_tickers.json",
        refresh=refresh,
        offline=offline,
    )
    lookup = {}
    for entry in payload.values():
        if not isinstance(entry, dict):
            continue
        ticker = str(entry.get("ticker") or "").upper().strip()
        try:
            cik = int(entry.get("cik_str"))
        except (TypeError, ValueError):
            continue
        if ticker and cik > 0:
            lookup[ticker] = {
                "cik": cik,
                "title": entry.get("title") or ticker,
            }
    return lookup


def _fetch_sec_payloads(
    cik: int,
    cache_dir: Path,
    refresh: bool,
    *,
    offline: bool = False,
) -> tuple[Dict[str, Any], Dict[str, Any], List[Dict[str, Any]]]:
    cik_key = f"{cik:010d}"
    issuer_dir = cache_dir / "sec" / cik_key
    submissions = _download_json(
        f"https://data.sec.gov/submissions/CIK{cik_key}.json",
        issuer_dir / "submissions.json",
        refresh=refresh,
        offline=offline,
    )
    companyfacts = _download_json(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik_key}.json",
        issuer_dir / "companyfacts.json",
        refresh=refresh,
        offline=offline,
    )
    historical = []
    files = (
        submissions.get("filings", {}).get("files", [])
        if isinstance(submissions.get("filings"), dict)
        else []
    )
    for item in files:
        name = str(item.get("name") or "") if isinstance(item, dict) else ""
        if not name.startswith("CIK") or not name.endswith(".json"):
            continue
        historical.append(
            _download_json(
                f"https://data.sec.gov/submissions/{name}",
                issuer_dir / name,
                refresh=refresh,
                offline=offline,
            )
        )
    return submissions, companyfacts, historical


def _normalize_prices(frame: pd.DataFrame, ticker: str) -> pd.DataFrame:
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return pd.DataFrame()
    normalized = frame.copy()
    if isinstance(normalized.columns, pd.MultiIndex):
        if ticker in normalized.columns.get_level_values(-1):
            normalized = normalized.xs(ticker, axis=1, level=-1)
        elif ticker in normalized.columns.get_level_values(0):
            normalized = normalized.xs(ticker, axis=1, level=0)
        else:
            normalized.columns = normalized.columns.get_level_values(0)
    return normalized


def _fetch_prices(
    ticker: str,
    cache_dir: Path,
    *,
    start: str,
    refresh: bool,
    offline: bool = False,
) -> pd.DataFrame:
    price_path = cache_dir / "prices" / f"{ticker}.csv"
    if price_path.exists() and not refresh:
        try:
            cached = pd.read_csv(price_path, index_col=0, parse_dates=True)
            if not cached.empty:
                return cached
        except (OSError, ValueError):
            pass

    if offline:
        raise FileNotFoundError(f"Cache prezzi mancante in modalita offline: {price_path}")

    end = (datetime.utcnow() + timedelta(days=2)).date().isoformat()
    frame = yf.download(
        ticker,
        start=start,
        end=end,
        auto_adjust=False,
        actions=False,
        progress=False,
        threads=False,
    )
    frame = _normalize_prices(frame, ticker)
    if frame.empty:
        ticker_object = yf.Ticker(ticker)
        frame = ticker_object.history(
            start=start,
            end=end,
            auto_adjust=False,
            actions=False,
        )
        frame = _normalize_prices(frame, ticker)
    if frame.empty:
        return frame
    price_path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(price_path)
    return frame


def _is_excluded_sic(submissions: Mapping[str, Any]) -> bool:
    try:
        sic = int(submissions.get("sic"))
    except (TypeError, ValueError):
        return False
    # Banche, assicurazioni, broker, fondi e REIT richiedono feature dedicate.
    return 6000 <= sic <= 6799


def _selected_tickers(raw: Optional[str], limit: Optional[int]) -> List[str]:
    if raw:
        tickers = [
            value.strip().upper()
            for value in raw.split(",")
            if value.strip()
        ]
    else:
        tickers = list(DEFAULT_UNIVERSE)
    deduplicated = list(dict.fromkeys(tickers))
    return deduplicated[:limit] if limit else deduplicated


def _iso_date(value: Any, *, field: str, ticker: str) -> Optional[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    parsed = pd.to_datetime(text, errors="coerce")
    if pd.isna(parsed):
        raise ValueError(
            f"Security master: {field} non valida per {ticker}: {value!r}"
        )
    return parsed.date().isoformat()


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, float) and pd.isna(value):
            continue
        if str(value).strip():
            return value
    return None


def _load_security_master(
    raw_path: Optional[str],
) -> tuple[Dict[str, List[Dict[str, Any]]], Dict[str, Any]]:
    if not raw_path:
        return {}, {
            "mode": "manual-current-universe",
            "historicalMembershipVerified": False,
            "sourcePath": None,
            "warning": (
                "Nessun security master point-in-time: appartenenza storica, "
                "delisting e cambi ticker non sono verificati."
            ),
        }
    path = Path(raw_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"Security master non trovato: {path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        records = pd.read_csv(path).to_dict(orient="records")
    elif suffix == ".json":
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict):
            records = payload.get("securities") or payload.get("records") or []
        else:
            records = payload
        if not isinstance(records, list):
            raise ValueError(
                "Security master JSON: atteso array o oggetto con securities/records."
            )
    else:
        raise ValueError("Security master: sono supportati soltanto CSV e JSON.")

    normalized_rows: List[Dict[str, Any]] = []
    invalid_rows = 0
    for position, raw in enumerate(records, start=1):
        if not isinstance(raw, dict):
            invalid_rows += 1
            continue
        ticker = str(raw.get("ticker") or "").strip().upper()
        if not ticker:
            raise ValueError(f"Security master: ticker mancante alla riga {position}.")
        valid_from = _iso_date(raw.get("valid_from"), field="valid_from", ticker=ticker)
        valid_to = _iso_date(
            _first_present(raw.get("valid_to"), raw.get("delist_date")),
            field="valid_to/delist_date",
            ticker=ticker,
        )
        if valid_from and valid_to and valid_from > valid_to:
            raise ValueError(
                f"Security master: intervallo invertito per {ticker} "
                f"({valid_from} > {valid_to})."
            )
        cik = _first_present(raw.get("cik"), raw.get("cik_str"))
        try:
            normalized_cik = int(cik) if cik not in (None, "") else None
        except (TypeError, ValueError):
            raise ValueError(f"Security master: CIK non valido per {ticker}: {cik!r}")
        delist_date = _iso_date(
            raw.get("delist_date"), field="delist_date", ticker=ticker
        )
        if delist_date and valid_from and delist_date < valid_from:
            raise ValueError(
                f"Security master: delist_date precedente a valid_from per {ticker}."
            )
        raw_delisting_return = _first_present(
            raw.get("delisting_return"), raw.get("delist_return")
        )
        delisting_return = None
        if raw_delisting_return is not None:
            try:
                delisting_return = float(raw_delisting_return)
            except (TypeError, ValueError):
                raise ValueError(
                    f"Security master: delisting_return non valido per {ticker}: "
                    f"{raw_delisting_return!r}"
                )
            if not math.isfinite(delisting_return) or delisting_return < -1.0:
                raise ValueError(
                    f"Security master: delisting_return deve essere finito e >= -1 "
                    f"per {ticker}."
                )
        canonical_ticker = str(
            _first_present(
                raw.get("canonical_ticker"),
                raw.get("current_ticker"),
            )
            or ""
        ).strip().upper() or None
        explicit_security_id = str(
            _first_present(
                raw.get("security_id"),
                raw.get("permanent_id"),
                raw.get("perm_id"),
            )
            or ""
        ).strip()
        security_id = (
            explicit_security_id
            or (f"CIK:{normalized_cik:010d}" if normalized_cik else f"TICKER:{canonical_ticker or ticker}")
        )
        sic_value = _first_present(raw.get("sic"), raw.get("sic_code"))
        sic = str(sic_value).strip() if sic_value is not None else None
        normalized_rows.append(
            {
                "security_id": security_id,
                "ticker": ticker,
                "canonical_ticker": canonical_ticker,
                "price_ticker": str(raw.get("price_ticker") or ticker).strip().upper(),
                "valid_from": valid_from,
                "valid_to": valid_to,
                "delist_date": delist_date,
                "delisting_return": delisting_return,
                "security_type": str(raw.get("security_type") or "").strip() or None,
                "sector": str(raw.get("sector") or "").strip() or None,
                "industry": str(raw.get("industry") or "").strip() or None,
                "sic": sic,
                "exchange": str(raw.get("exchange") or "").strip() or None,
                "sector_benchmark": str(
                    raw.get("sector_benchmark") or ""
                ).strip().upper() or None,
                "cik": normalized_cik,
            }
        )
    if not normalized_rows:
        raise ValueError("Security master vuoto: nessun ticker utilizzabile.")

    def interval_bounds(row: Mapping[str, Any]) -> tuple[pd.Timestamp, pd.Timestamp]:
        lower = pd.Timestamp(row.get("valid_from") or "1900-01-01")
        upper = pd.Timestamp(row.get("valid_to") or "2262-01-01")
        return lower, upper

    def reject_overlaps(group_name: str, grouped: Mapping[str, List[Dict[str, Any]]]) -> None:
        for key, rows in grouped.items():
            ordered = sorted(rows, key=lambda item: interval_bounds(item)[0])
            for previous, current in zip(ordered, ordered[1:]):
                _, previous_end = interval_bounds(previous)
                current_start, _ = interval_bounds(current)
                if current_start <= previous_end:
                    raise ValueError(
                        "Security master: intervalli sovrapposti per "
                        f"{group_name}={key} ({previous.get('ticker')} e "
                        f"{current.get('ticker')})."
                    )

    by_security: Dict[str, List[Dict[str, Any]]] = {}
    by_ticker: Dict[str, List[Dict[str, Any]]] = {}
    for row in normalized_rows:
        by_security.setdefault(row["security_id"], []).append(row)
        by_ticker.setdefault(row["ticker"], []).append(row)
    reject_overlaps("security_id", by_security)
    reject_overlaps("ticker", by_ticker)

    lookup: Dict[str, List[Dict[str, Any]]] = {}
    for security_id, rows in by_security.items():
        explicit = [row["canonical_ticker"] for row in rows if row["canonical_ticker"]]
        if explicit and len(set(explicit)) != 1:
            raise ValueError(
                f"Security master: canonical_ticker incoerente per {security_id}."
            )
        latest = max(
            rows,
            key=lambda item: (
                item.get("valid_to") is None,
                item.get("valid_from") or "0000-01-01",
            ),
        )
        canonical = explicit[0] if explicit else latest["ticker"]
        enriched_rows = []
        for row in rows:
            enriched_rows.append({**row, "canonical_ticker": canonical})
        enriched_rows.sort(key=lambda item: item.get("valid_from") or "0000-01-01")
        if canonical in lookup:
            raise ValueError(
                f"Security master: canonical_ticker duplicato tra security_id: {canonical}."
            )
        lookup[canonical] = enriched_rows

    return lookup, {
        "schemaVersion": "security-master-v5.1",
        "mode": "point-in-time-security-master",
        "historicalMembershipVerified": True,
        # Non serializzare path assoluti nell'artifact portabile.
        "sourceName": path.name,
        "rows": sum(len(rows) for rows in lookup.values()),
        "issuers": len(lookup),
        "tickers": len({row["ticker"] for rows in lookup.values() for row in rows}),
        "invalidRowsSkipped": invalid_rows,
        "recordsWithDelistDate": sum(
            bool(row.get("delist_date")) for rows in lookup.values() for row in rows
        ),
        "fields": [
            "ticker",
            "canonical_ticker",
            "security_id",
            "valid_from",
            "valid_to",
            "delist_date",
            "delisting_return",
            "security_type",
            "sector",
            "industry",
            "sic",
            "exchange",
            "sector_benchmark",
            "cik",
        ],
        "temporalValidation": {
            "intervalsInclusive": True,
            "overlapBySecurityIdRejected": True,
            "overlapByTickerRejected": True,
            "missingMembershipFailsClosed": True,
        },
    }


def _security_reference(
    ticker: str,
    rows: Sequence[Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    with_cik = [row for row in rows if row.get("cik")]
    if not with_cik:
        return None
    return {"cik": int(with_cik[-1]["cik"]), "title": ticker}


def _apply_security_master(
    samples: Sequence[Mapping[str, Any]],
    security_rows: Sequence[Mapping[str, Any]],
) -> tuple[List[Dict[str, Any]], int]:
    if not security_rows:
        return [
            {**dict(sample), "security_master_verified": False}
            for sample in samples
        ], 0
    output = []
    excluded = 0
    for sample in samples:
        snapshot = str(sample.get("snapshot_date") or "")[:10]
        selected = resolve_security_point_in_time(security_rows, snapshot)
        if selected is None:
            excluded += 1
            continue
        enriched = {
            **dict(sample),
            "security_id": selected.get("security_id"),
            "security_ticker_asof": selected.get("ticker"),
            "security_canonical_ticker": selected.get("canonical_ticker"),
            "security_valid_from": selected.get("valid_from"),
            "security_valid_to": selected.get("valid_to"),
            "security_delist_date": selected.get("delist_date"),
            "security_delisting_return": selected.get("delisting_return"),
            "security_type": selected.get("security_type"),
            "security_sector": selected.get("sector"),
            "security_industry": selected.get("industry"),
            "security_sic": selected.get("sic"),
            "security_exchange": selected.get("exchange"),
            "security_sector_benchmark": selected.get("sector_benchmark"),
            "security_master_verified": True,
        }
        for horizon in HORIZONS:
            label_date = str(enriched.get(f"label_date_{horizon}") or "")[:10]
            label_security = (
                resolve_security_point_in_time(security_rows, label_date)
                if label_date
                else None
            )
            includes_delisting = bool(
                enriched.get(f"target_includes_delisting_return_{horizon}")
            )
            censored = bool(
                label_date
                and label_security is None
                and not includes_delisting
            )
            enriched[f"target_censored_by_security_end_{horizon}"] = censored
            enriched[f"security_delisting_return_included_{horizon}"] = (
                includes_delisting if selected.get("delist_date") else None
            )
            if censored:
                enriched[f"target_{horizon}"] = None
                enriched[f"target_raw_{horizon}"] = None
                enriched[f"label_date_{horizon}"] = None
                enriched[f"target_excess_{horizon}"] = None
                for benchmark_name in ("excess", "market", "sector"):
                    enriched[f"target_{benchmark_name}_relative_{horizon}"] = None
                enriched[f"target_market_sector_neutral_{horizon}"] = None
        output.append(enriched)
    return output, excluded


def _security_rows_for_symbol(
    security_master: Mapping[str, Sequence[Mapping[str, Any]]],
    symbol: str,
) -> List[Dict[str, Any]]:
    normalized = str(symbol or "").strip().upper()
    direct = security_master.get(normalized)
    if direct is not None:
        return [dict(row) for row in direct]
    for rows in security_master.values():
        if any(str(row.get("ticker") or "").upper() == normalized for row in rows):
            return [dict(row) for row in rows]
    return []


def _security_master_runtime_payload(
    security_master: Mapping[str, Sequence[Mapping[str, Any]]],
) -> Dict[str, Any]:
    """Payload compatto e portabile riusabile dall'inference runtime."""

    issuers = []
    for canonical, rows in sorted(security_master.items()):
        if not rows:
            continue
        security_id = rows[0].get("security_id")
        aliases = []
        for row in rows:
            aliases.append(
                {
                    "ticker": row.get("ticker"),
                    "priceTicker": row.get("price_ticker"),
                    "validFrom": row.get("valid_from"),
                    "validTo": row.get("valid_to"),
                    "delistDate": row.get("delist_date"),
                    "delistingReturn": row.get("delisting_return"),
                    "sector": row.get("sector"),
                    "industry": row.get("industry"),
                    "sic": row.get("sic"),
                    "exchange": row.get("exchange"),
                    "securityType": row.get("security_type"),
                    "sectorBenchmark": row.get("sector_benchmark"),
                    "cik": row.get("cik"),
                }
            )
        issuers.append(
            {
                "securityId": security_id,
                "canonicalTicker": canonical,
                "currentTicker": canonical,
                "aliases": aliases,
            }
        )
    return {
        "schemaVersion": "security-master-runtime-v5.1",
        "intervalSemantics": "inclusive",
        "issuers": issuers,
    }


def _fetch_security_prices(
    canonical_ticker: str,
    security_rows: Sequence[Mapping[str, Any]],
    cache_dir: Path,
    *,
    start: str,
    refresh: bool,
    offline: bool,
) -> pd.DataFrame:
    """Unisce cache/prezzi degli alias rispettando i loro intervalli PIT."""

    if not security_rows:
        return _fetch_prices(
            canonical_ticker,
            cache_dir,
            start=start,
            refresh=refresh,
            offline=offline,
        )
    stitched: List[pd.DataFrame] = []
    seen = set()
    for row in security_rows:
        price_ticker = str(
            row.get("price_ticker") or row.get("ticker") or canonical_ticker
        ).strip().upper()
        cache_key = (
            price_ticker,
            row.get("valid_from"),
            row.get("valid_to") or row.get("delist_date"),
        )
        if cache_key in seen:
            continue
        seen.add(cache_key)
        alias_prices = _fetch_prices(
            price_ticker,
            cache_dir,
            start=start,
            refresh=refresh,
            offline=offline,
        )
        if alias_prices.empty:
            continue
        alias_prices = alias_prices.copy()
        alias_prices.index = pd.to_datetime(alias_prices.index)
        if row.get("valid_from"):
            alias_prices = alias_prices.loc[
                alias_prices.index >= pd.Timestamp(row["valid_from"])
            ]
        valid_to = row.get("valid_to") or row.get("delist_date")
        if valid_to:
            alias_prices = alias_prices.loc[
                alias_prices.index <= pd.Timestamp(valid_to)
            ]
        if not alias_prices.empty:
            alias_prices["Security Ticker"] = price_ticker
            stitched.append(alias_prices)
    if not stitched:
        return pd.DataFrame()
    combined = pd.concat(stitched).sort_index()
    # Gli overlap sono gia rifiutati dal loader; questo elimina soltanto
    # eventuali duplicati di calendario identici in cache.
    return combined.loc[~combined.index.duplicated(keep="last")]


def _load_records_by_symbol(
    raw_path: Optional[str],
    *,
    label: str,
) -> tuple[Dict[str, List[Dict[str, Any]]], Dict[str, Any]]:
    if not raw_path:
        return {}, {"sourceName": None, "records": 0, "symbols": 0}
    path = Path(raw_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"{label} non trovato: {path}")
    if path.suffix.lower() == ".csv":
        records = pd.read_csv(path).to_dict(orient="records")
    elif path.suffix.lower() == ".json":
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        records = (
            payload.get("records") or payload.get("events") or []
            if isinstance(payload, dict)
            else payload
        )
    else:
        raise ValueError(f"{label}: sono supportati soltanto CSV e JSON.")
    if not isinstance(records, list):
        raise ValueError(f"{label}: formato record non valido.")
    lookup: Dict[str, List[Dict[str, Any]]] = {}
    for position, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            continue
        symbol = str(
            _first_present(
                record.get("canonical_ticker"),
                record.get("ticker"),
                record.get("security_id"),
            )
            or ""
        ).strip().upper()
        if not symbol:
            raise ValueError(f"{label}: ticker/security_id mancante alla riga {position}.")
        lookup.setdefault(symbol, []).append(dict(record))
    return lookup, {
        "sourceName": path.name,
        "records": sum(len(rows) for rows in lookup.values()),
        "symbols": len(lookup),
    }


def _events_for_security(
    lookup: Mapping[str, Sequence[Mapping[str, Any]]],
    canonical_ticker: str,
    security_rows: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    keys = {
        str(canonical_ticker).upper(),
        *{
            str(row.get("ticker") or "").upper()
            for row in security_rows
            if row.get("ticker")
        },
        *{
            str(row.get("security_id") or "").upper()
            for row in security_rows
            if row.get("security_id")
        },
    }
    output: List[Dict[str, Any]] = []
    for key in keys:
        output.extend(dict(record) for record in lookup.get(key, []))
    return output


def _load_sector_benchmark_map(
    raw_path: Optional[str],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Carica una mappa settore/SIC -> ETF con intervalli opzionali."""

    if not raw_path:
        return [], {"sourceName": None, "records": 0}
    path = Path(raw_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"Mappa benchmark settore non trovata: {path}")
    if path.suffix.lower() == ".csv":
        records = pd.read_csv(path).to_dict(orient="records")
    elif path.suffix.lower() == ".json":
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        records = payload.get("mappings") or payload.get("records") or [] if isinstance(payload, dict) else payload
    else:
        raise ValueError("Mappa benchmark settore: supportati soltanto CSV e JSON.")
    if not isinstance(records, list):
        raise ValueError("Mappa benchmark settore: formato non valido.")
    normalized = []
    for position, raw in enumerate(records, start=1):
        if not isinstance(raw, dict):
            continue
        sector = str(raw.get("sector") or "").strip()
        sic = str(_first_present(raw.get("sic"), raw.get("sic_code")) or "").strip()
        benchmark = str(
            _first_present(raw.get("benchmark"), raw.get("sector_benchmark")) or ""
        ).strip().upper()
        if not benchmark or (not sector and not sic):
            raise ValueError(
                "Mappa benchmark settore: ogni riga richiede benchmark e sector o SIC "
                f"(riga {position})."
            )
        normalized.append(
            {
                "sector": sector or None,
                "sic": sic or None,
                "benchmark": benchmark,
                "valid_from": _iso_date(
                    raw.get("valid_from"), field="valid_from", ticker=sector or sic
                ),
                "valid_to": _iso_date(
                    raw.get("valid_to"), field="valid_to", ticker=sector or sic
                ),
            }
        )
    return normalized, {"sourceName": path.name, "records": len(normalized)}


def _apply_sector_benchmark_map(
    security_master: Mapping[str, Sequence[Mapping[str, Any]]],
    mappings: Sequence[Mapping[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    if not mappings:
        return {key: [dict(row) for row in rows] for key, rows in security_master.items()}
    output: Dict[str, List[Dict[str, Any]]] = {}
    for canonical, rows in security_master.items():
        enriched_rows = []
        for row in rows:
            if row.get("sector_benchmark"):
                enriched_rows.append(dict(row))
                continue
            candidates = []
            for mapping in mappings:
                identity_matches = bool(
                    (mapping.get("sic") and str(mapping.get("sic")) == str(row.get("sic")))
                    or (
                        mapping.get("sector")
                        and str(mapping.get("sector")).casefold()
                        == str(row.get("sector") or "").casefold()
                    )
                )
                if not identity_matches:
                    continue
                row_start = row.get("valid_from") or "1900-01-01"
                row_end = row.get("valid_to") or "2262-01-01"
                map_start = mapping.get("valid_from") or "1900-01-01"
                map_end = mapping.get("valid_to") or "2262-01-01"
                if map_start <= row_start and row_end <= map_end:
                    candidates.append(mapping)
            if len(candidates) > 1:
                # Preferisci la mappa SIC, piu specifica, poi la piu recente.
                candidates.sort(
                    key=lambda item: (
                        bool(item.get("sic")),
                        item.get("valid_from") or "0000-01-01",
                    )
                )
            benchmark = candidates[-1].get("benchmark") if candidates else None
            enriched_rows.append({**dict(row), "sector_benchmark": benchmark})
        output[canonical] = enriched_rows
    return output


def _dataset_audit(
    rows: Sequence[Mapping[str, Any]],
    *,
    evaluation_years: int,
    filing_frequency: str,
    target_kind: str,
) -> Dict[str, Any]:
    snapshot_dates = sorted(
        str(row.get("snapshot_date"))[:10]
        for row in rows
        if row.get("snapshot_date")
    )
    years = sorted({value[:4] for value in snapshot_dates})
    evaluation_count = max(0, int(evaluation_years))
    independent_years = years[-evaluation_count:] if years and evaluation_count else []
    missingness = {}
    audited_features = list(FEATURE_NAMES)
    if any(any(name in row for name in V5_MARKET_FEATURE_NAMES) for row in rows):
        audited_features.extend(
            name for name in V5_MARKET_FEATURE_NAMES if name not in audited_features
        )
    for feature in audited_features:
        missing = sum(
            row.get(feature) is None or pd.isna(row.get(feature)) for row in rows
        )
        missingness[feature] = {
            "missing": int(missing),
            "available": int(len(rows) - missing),
            "missingRate": missing / max(1, len(rows)),
        }
    target_availability = {}
    for horizon in HORIZONS:
        available = [
            row
            for row in rows
            if row.get(f"target_{horizon}") is not None
            and row.get(f"label_date_{horizon}")
        ]
        labels = sorted(str(row[f"label_date_{horizon}"])[:10] for row in available)
        target_availability[horizon] = {
            "available": len(available),
            "missingOrUnmatured": len(rows) - len(available),
            "coverage": len(available) / max(1, len(rows)),
            "firstLabelDate": labels[0] if labels else None,
            "lastLabelDate": labels[-1] if labels else None,
        }
    leakage_audit = audit_market_feature_leakage(rows)
    return {
        "filingFrequency": filing_frequency,
        "forms": dict(Counter(str(row.get("filing_form") or "unknown") for row in rows)),
        "target": {
            "kind": target_kind,
            "rawTargetPreservedIn": "target_raw_<horizon>",
            "relativeDefinition": (
                "raw - beta_asof * market - (sector - market)"
                if target_kind == "market-sector-neutral"
                else "stock adjusted total return minus benchmark adjusted total return"
            ),
            "betaOrFactorNeutralized": target_kind == "market-sector-neutral",
            "availability": target_availability,
        },
        "temporalSplit": {
            "protocol": "annual-expanding-walk-forward-with-mature-labels",
            "embargoDays": 7,
            "evaluationYearsRequested": int(evaluation_years),
            "independentSnapshotYears": independent_years,
            "snapshotStart": snapshot_dates[0] if snapshot_dates else None,
            "snapshotEnd": snapshot_dates[-1] if snapshot_dates else None,
            "rowsBySnapshotYear": dict(
                Counter(value[:4] for value in snapshot_dates)
            ),
            "overlappingForwardLabelsPossible": True,
        },
        "missingness": {
            "features": missingness,
            "averageFeatureCoverage": (
                sum(float(row.get("feature_coverage") or 0.0) for row in rows)
                / max(1, len(rows))
            ),
            "minimumFeatureCoverage": min(
                (float(row.get("feature_coverage") or 0.0) for row in rows),
                default=None,
            ),
        },
        "pointInTimeFeatureAudit": leakage_audit,
        "unitsAndCurrency": {
            "currencies": dict(
                Counter(str(row.get("currency") or "unknown") for row in rows)
            ),
            "statuses": dict(
                Counter(str(row.get("unit_audit_status") or "unknown") for row in rows)
            ),
            "mixedCurrencyRows": sum(bool(row.get("mixed_currency")) for row in rows),
            "currencyConversionApplied": False,
        },
    }


def _build_model_configs(args: argparse.Namespace) -> Dict[str, Dict[str, Any]]:
    """Traduce i flag CLI in override comuni e validati per i due booster."""

    profile = str(
        getattr(args, "tree_loss_profile", "squared_error") or "squared_error"
    ).strip().lower()
    allowed_profiles = {"squared_error", "huber", "quantile"}
    if profile not in allowed_profiles:
        raise ValueError(
            f"Profilo loss alberi non valido: {profile!r}; "
            f"attesi {sorted(allowed_profiles)}."
        )

    raw_quantile_alpha = getattr(args, "quantile_alpha", None)
    quantile_alpha = None
    if profile == "quantile":
        quantile_alpha = (
            0.5 if raw_quantile_alpha is None else float(raw_quantile_alpha)
        )
        if not 0.0 < quantile_alpha < 1.0:
            raise ValueError(
                "--quantile-alpha deve essere strettamente compreso tra 0 e 1."
            )
    elif raw_quantile_alpha is not None:
        raise ValueError(
            "--quantile-alpha e valido soltanto con "
            "--tree-loss-profile quantile."
        )

    raw_early_stopping = getattr(args, "early_stopping_rounds", 40)
    early_stopping_rounds = (
        40 if raw_early_stopping is None else int(raw_early_stopping)
    )
    if early_stopping_rounds < 0:
        raise ValueError("--early-stopping-rounds non puo essere negativo.")

    raw_tree_rounds = getattr(args, "tree_rounds", 240)
    tree_rounds = None if raw_tree_rounds is None else int(raw_tree_rounds)
    if tree_rounds is not None and tree_rounds <= 0:
        raise ValueError("--tree-rounds deve essere maggiore di zero.")

    common: Dict[str, Any] = {
        "robust_profile": profile,
        "early_stopping_rounds": early_stopping_rounds,
    }
    if tree_rounds is not None:
        common["num_boost_round"] = tree_rounds
    if quantile_alpha is not None:
        common["quantile_alpha"] = quantile_alpha
    catboost = {
        "robust_profile": (
            "huber"
            if str(getattr(args, "data_profile", "v4") or "v4").lower() == "v5"
            else profile
        ),
        "early_stopping_rounds": early_stopping_rounds,
        "learning_rate": 0.03,
        "depth": 5,
    }
    if tree_rounds is not None:
        catboost["num_boost_round"] = tree_rounds
    return {
        "xgboost": dict(common),
        "lightgbm": dict(common),
        "catboost": catboost,
    }


def _resolved_target_kind(args: argparse.Namespace) -> str:
    selected = str(getattr(args, "target_kind", "raw") or "raw").lower()
    profile = str(getattr(args, "data_profile", "v4") or "v4").lower()
    if profile == "v5" and not bool(getattr(args, "target_kind_explicit", False)):
        return "market-sector-neutral"
    return selected


def train(args: argparse.Namespace) -> Dict[str, Any]:
    cache_dir = Path(args.cache_dir).resolve()
    output_path = Path(args.output).resolve()
    model_configs = _build_model_configs(args)
    offline = bool(getattr(args, "offline", False))
    if offline and (args.refresh or args.refresh_prices):
        raise ValueError("--offline non e compatibile con --refresh/--refresh-prices.")
    data_profile = str(getattr(args, "data_profile", "v4") or "v4").lower()
    security_master, universe_audit = _load_security_master(
        getattr(args, "security_master", None)
    )
    sector_mappings, sector_mapping_audit = _load_sector_benchmark_map(
        getattr(args, "sector_benchmark_map", None)
    )
    security_master = _apply_sector_benchmark_map(
        security_master, sector_mappings
    )
    universe_size = int(getattr(args, "universe_size", 2000) or 2000)
    if universe_size <= 0 or universe_size > 3000:
        raise ValueError("--universe-size deve essere compreso tra 1 e 3000.")
    universe_source = str(
        getattr(args, "universe_source", "security-master")
        or "security-master"
    ).lower()
    if security_master and not args.tickers:
        tickers = list(security_master)
        cap = min(universe_size, int(args.limit)) if args.limit else universe_size
        tickers = tickers[:cap]
    elif args.tickers:
        tickers = _selected_tickers(args.tickers, args.limit or universe_size)
    elif data_profile == "v4" or universe_source == "legacy-default":
        tickers = _selected_tickers(None, args.limit or universe_size)
    else:
        raise ValueError(
            "Il profilo v5 richiede --security-master o --tickers; "
            "l'universo current-only hard-coded non viene usato implicitamente."
        )
    # Con un security master completo il CIK storico e autorevole e non serve
    # consultare la lista SEC current-only (importante anche in offline mode).
    missing_master_cik = any(
        not _security_reference(ticker, _security_rows_for_symbol(security_master, ticker))
        for ticker in tickers
    )
    lookup = (
        _ticker_lookup(cache_dir, args.refresh, offline=offline)
        if missing_master_cik
        else {}
    )
    filing_frequency = str(
        getattr(args, "filing_frequency", "annual") or "annual"
    ).lower()
    include_quarterly = filing_frequency == "quarterly"
    target_kind = _resolved_target_kind(args)
    benchmark_symbols = {
        "market": getattr(args, "market_benchmark", None)
        or ("SPY" if target_kind == "market-sector-neutral" else None),
        "sector": getattr(args, "sector_benchmark", None),
        "excess": getattr(args, "excess_benchmark", None),
    }
    required_symbol = {
        "market-relative": benchmark_symbols["market"],
        "sector-relative": benchmark_symbols["sector"],
        "excess": benchmark_symbols["excess"],
        "market-sector-neutral": benchmark_symbols["market"],
    }.get(target_kind)
    if target_kind != "raw" and not required_symbol:
        flag = {
            "market-relative": "--market-benchmark",
            "sector-relative": "--sector-benchmark",
            "excess": "--excess-benchmark",
            "market-sector-neutral": "--market-benchmark",
        }.get(target_kind)
        raise ValueError(f"--target-kind {target_kind} richiede {flag}.")
    benchmark_prices = {}
    for benchmark_name, symbol in benchmark_symbols.items():
        if not symbol:
            continue
        benchmark_prices[benchmark_name] = _fetch_prices(
            str(symbol).strip().upper(),
            cache_dir,
            start="2008-01-01",
            refresh=args.refresh_prices,
            offline=offline,
        )
        if benchmark_prices[benchmark_name].empty:
            raise RuntimeError(
                f"Prezzi benchmark non disponibili: {benchmark_name}={symbol}"
            )
    sector_symbols = {
        str(row.get("sector_benchmark") or "").strip().upper()
        for rows in security_master.values()
        for row in rows
        if row.get("sector_benchmark")
    }
    if benchmark_symbols.get("sector"):
        sector_symbols.add(str(benchmark_symbols["sector"]).strip().upper())
    if target_kind == "market-sector-neutral" and not sector_symbols:
        raise ValueError(
            "Il target market-sector-neutral richiede sector_benchmark nel security "
            "master, --sector-benchmark-map o --sector-benchmark."
        )
    sector_benchmark_prices: Dict[str, pd.DataFrame] = {}
    for symbol in sorted(sector_symbols):
        sector_benchmark_prices[symbol] = _fetch_prices(
            symbol,
            cache_dir,
            start="2008-01-01",
            refresh=args.refresh_prices,
            offline=offline,
        )
        if sector_benchmark_prices[symbol].empty:
            raise RuntimeError(f"Prezzi benchmark settore non disponibili: {symbol}")
    earnings_lookup, earnings_audit = _load_records_by_symbol(
        getattr(args, "market_events", None), label="Eventi earnings"
    )
    revisions_lookup, revisions_audit = _load_records_by_symbol(
        getattr(args, "estimate_revisions", None), label="Revisioni stime"
    )
    raw_market_features = getattr(args, "enable_market_features", None)
    enable_market_features = (
        data_profile == "v5"
        if raw_market_features is None
        else bool(raw_market_features)
    )
    all_samples: List[Dict[str, Any]] = []
    issuer_audit = []

    for index, ticker in enumerate(tickers, start=1):
        print(f"[{index:02d}/{len(tickers):02d}] {ticker}: acquisizione point-in-time...")
        security_rows = _security_rows_for_symbol(security_master, ticker)
        if security_master and not security_rows:
            issuer_audit.append(
                {"ticker": ticker, "status": "missing-security-master-membership"}
            )
            print("  - ticker assente dal security master")
            continue
        reference = _security_reference(ticker, security_rows) or lookup.get(ticker)
        if not reference:
            issuer_audit.append({"ticker": ticker, "status": "missing-cik"})
            print("  - CIK non trovato")
            continue
        try:
            submissions, companyfacts, historical = _fetch_sec_payloads(
                reference["cik"],
                cache_dir,
                args.refresh,
                offline=offline,
            )
            if _is_excluded_sic(submissions):
                issuer_audit.append({"ticker": ticker, "status": "excluded-financial"})
                print("  - escluso: SIC finanziario/REIT")
                continue
            filing_index = build_filing_index(
                submissions,
                historical,
                include_quarterly=include_quarterly,
            )
            vintages = (
                extract_filing_vintages(
                    companyfacts,
                    filing_index,
                    include_quarterly=True,
                )
                if include_quarterly
                else extract_annual_vintages(companyfacts, filing_index)
            )
            if len(vintages) < 3:
                issuer_audit.append(
                    {
                        "ticker": ticker,
                        "status": "insufficient-filings",
                        "vintages": len(vintages),
                    }
                )
                print(f"  - filing utili insufficienti ({len(vintages)})")
                continue
            first_year = max(2008, vintages[0]["acceptedAt"].year - 1)
            prices = _fetch_security_prices(
                ticker,
                security_rows,
                cache_dir,
                start=f"{first_year}-01-01",
                refresh=args.refresh_prices,
                offline=offline,
            )
            issuer_events = _events_for_security(
                earnings_lookup, ticker, security_rows
            )
            issuer_revisions = _events_for_security(
                revisions_lookup, ticker, security_rows
            )
            samples = build_monthly_samples(
                ticker,
                vintages,
                prices,
                benchmark_prices=benchmark_prices,
                benchmark_symbols=benchmark_symbols,
                target_kind=target_kind,
                max_filing_age_days=getattr(args, "max_filing_age_days", None),
                security_timeline=security_rows,
                sector_benchmark_prices=sector_benchmark_prices,
                earnings_events=issuer_events,
                estimate_revisions=issuer_revisions,
                enable_market_features=enable_market_features,
            )
            samples, security_excluded = _apply_security_master(samples, security_rows)
            all_samples.extend(samples)
            form_counts = Counter(str(item.get("form") or "unknown") for item in vintages)
            unit_statuses = Counter(
                str((item.get("unitAudit") or {}).get("status") or "unknown")
                for item in vintages
            )
            currencies = Counter(
                str((item.get("unitAudit") or {}).get("currency") or "unknown")
                for item in vintages
            )
            issuer_audit.append(
                {
                    "ticker": ticker,
                    "status": "included",
                    "vintages": len(vintages),
                    "samples": len(samples),
                    "sic": submissions.get("sic"),
                    "forms": dict(form_counts),
                    "acceptanceFallbackFilings": sum(
                        bool(item.get("acceptanceFallback")) for item in vintages
                    ),
                    "averageMetricCoverage": (
                        sum(float(item.get("metricCoverage") or 0.0) for item in vintages)
                        / max(1, len(vintages))
                    ),
                    "averageTtmCoverage": (
                        sum(float((item.get("ttm") or {}).get("coverage") or 0.0) for item in vintages)
                        / max(1, len(vintages))
                    ),
                    "unitAuditStatuses": dict(unit_statuses),
                    "currencies": dict(currencies),
                    "securityMasterRows": len(security_rows),
                    "securityMasterExcludedSnapshots": security_excluded,
                    "marketEventRows": len(issuer_events),
                    "estimateRevisionRows": len(issuer_revisions),
                }
            )
            print(f"  - {len(vintages)} filing, {len(samples)} snapshot")
        except Exception as exc:
            issuer_audit.append(
                {
                    "ticker": ticker,
                    "status": "error",
                    "reason": str(exc)[:240],
                }
            )
            print(f"  - errore: {exc}")

    if not all_samples:
        raise RuntimeError("Nessun campione valido: artifact non creato.")

    included = [
        item["ticker"] for item in issuer_audit if item["status"] == "included"
    ]
    algorithms = [
        value.strip().lower()
        for value in str(args.algorithms or "").split(",")
        if value.strip()
    ]
    ranking_horizons = {
        value.strip().lower()
        for value in str(getattr(args, "ranking_horizons", "3m") or "").split(",")
        if value.strip()
    }
    unknown_ranking_horizons = ranking_horizons - set(HORIZONS)
    if unknown_ranking_horizons:
        raise ValueError(
            "--ranking-horizons contiene valori non validi: "
            + ", ".join(sorted(unknown_ranking_horizons))
        )
    objective_modes_by_horizon = {
        horizon: {
            "xgboost": "ranking" if horizon in ranking_horizons else "regression",
            "lightgbm": "ranking" if horizon in ranking_horizons else "regression",
            "catboost": "regression",
            "default": "regression",
        }
        for horizon in HORIZONS
    }
    base_feature_names = list(FEATURE_NAMES)
    feature_names_by_horizon = {
        "1m": [*base_feature_names, *V5_MARKET_FEATURE_NAMES]
        if enable_market_features
        else base_feature_names,
        "3m": [*base_feature_names, *V5_MARKET_FEATURE_NAMES]
        if enable_market_features
        else base_feature_names,
        "1y": base_feature_names,
    }
    categorical_feature_names = (
        list(V5_CATEGORICAL_FEATURE_NAMES) if security_master else []
    )
    raw_oof_ensemble = getattr(args, "enable_oof_ensemble", None)
    enable_oof_ensemble = (
        data_profile == "v5"
        if raw_oof_ensemble is None
        else bool(raw_oof_ensemble)
    )
    data_audit = _dataset_audit(
        all_samples,
        evaluation_years=args.evaluation_years,
        filing_frequency=filing_frequency,
        target_kind=target_kind,
    )
    known_limitations = [
        "Yahoo Finance e usato per ricerca personale; verificarne i termini prima di un uso commerciale.",
        "I fondamentali hanno in genere segnale debole soprattutto a un mese.",
        (
            "La conferma usa gli anni finali disponibili come holdout: va "
            "ripetuta su nuovi dati a ogni retraining."
        ),
        (
            "La policy relativa sul Rank IC e congelata dal 2026-07-30: "
            "ogni promozione che la usa resta esplorativa fino a una "
            "conferma su una finestra successiva."
        ),
        (
            "Le label forward mensili possono sovrapporsi; l'audit le segnala "
            "ma questa pipeline conserva il protocollo walk-forward v3."
        ),
    ]
    if not security_master:
        known_limitations.insert(
            0, "Universo manuale corrente: possibile survivorship e delisting bias."
        )
    else:
        known_limitations.insert(
            0,
            (
                "Il security master filtra l'appartenenza storica dichiarata, "
                "ma completezza, delisting return e cambi identificativo "
                "dipendono dal file fornito."
            ),
        )
    if include_quarterly:
        known_limitations.append(
            (
                "I TTM 10-Q richiedono 10-K e YTD comparabile gia pubblicati; "
                "le metriche non ricostruibili restano mancanti."
            )
        )
    else:
        known_limitations.append(
            "Modalita annuale: sono usati soltanto filing originali 10-K US-GAAP."
        )
    artifact = fit_artifact(
        all_samples,
        alpha=args.alpha,
        feature_names_by_horizon=feature_names_by_horizon,
        categorical_feature_names=categorical_feature_names,
        objective_modes_by_horizon=objective_modes_by_horizon,
        enable_oof_ensemble=enable_oof_ensemble,
        minimum_training_rows=args.minimum_training_rows,
        minimum_test_rows=args.minimum_test_rows,
        algorithms=algorithms,
        model_configs=model_configs,
        seed=args.seed,
        evaluation_years=args.evaluation_years,
        metadata={
            "requestedIssuers": len(tickers),
            "includedIssuers": len(included),
            "issuerAudit": issuer_audit,
            "source": "SEC EDGAR Company Facts + Yahoo Finance adjusted prices",
            "sourceAccess": {
                "offlineCacheOnly": offline,
                "secRefresh": bool(args.refresh),
                "priceRefresh": bool(args.refresh_prices),
                "cacheDirectory": str(cache_dir),
            },
            "dataProfile": data_profile,
            "featurePolicy": {
                "marketEventEnabled": enable_market_features,
                "shortHorizonOnly": ["1m", "3m"],
                "numericMarketEventFeatures": list(V5_MARKET_FEATURE_NAMES),
                "explicitMissingFlags": list(V5_MARKET_MISSING_FLAG_NAMES),
                "categoricalFeatures": categorical_feature_names,
                "cutoffPolicy": "source timestamp <= snapshot date",
                "futureEventsRejected": True,
            },
            "marketEventSources": {
                "earnings": earnings_audit,
                "estimateRevisions": revisions_audit,
            },
            "treeTrainingPolicy": {
                "lossProfile": model_configs["xgboost"]["robust_profile"],
                "quantileAlpha": model_configs["xgboost"].get("quantile_alpha"),
                "earlyStoppingRounds": model_configs["xgboost"][
                    "early_stopping_rounds"
                ],
                "maximumBoostRounds": model_configs["xgboost"].get(
                    "num_boost_round"
                ),
                "validationPolicy": "temporal validation only; never random split",
            },
            "universeMethod": universe_audit["mode"],
            "universeAudit": {
                **universe_audit,
                "requestedMaximum": universe_size,
                "source": universe_source,
                "currentOnlyHardcodedDefaultUsed": (
                    data_profile == "v4" or universe_source == "legacy-default"
                )
                and not security_master
                and not args.tickers,
                "sectorBenchmarkMap": sector_mapping_audit,
            },
            "securityMasterRuntime": _security_master_runtime_payload(
                security_master
            ),
            "filingPolicy": {
                "frequency": filing_frequency,
                "forms": ["10-K", "10-Q"] if include_quarterly else ["10-K"],
                "amendmentsIncluded": False,
                "acceptanceTimestampRequired": True,
                "acceptanceFallback": (
                    "filingDate 23:59:59 only when SEC history omits acceptanceDateTime"
                ),
                "restatementPolicy": "exact-original-accession-only",
                "ttmMethod": (
                    "10-K + current YTD - prior-year comparable YTD"
                    if include_quarterly
                    else "reported annual"
                ),
            },
            "targetPolicy": {
                "selected": target_kind,
                "rawBackwardCompatible": True,
                "rawField": "target_raw_<horizon>",
                "trainingField": "target_<horizon>",
                "benchmarks": {
                    key: str(value).strip().upper()
                    for key, value in benchmark_symbols.items()
                    if value
                },
                "relativeDefinition": (
                    "raw - beta_asof * market - (sector - market)"
                    if target_kind == "market-sector-neutral"
                    else "stock adjusted total return minus benchmark adjusted total return"
                ),
                "betaOrFactorNeutralized": target_kind
                == "market-sector-neutral",
                "pointInTimeSectorBenchmark": target_kind
                == "market-sector-neutral",
            },
            "objectivePolicy": {
                "byHorizon": objective_modes_by_horizon,
                "rankingQuery": "snapshot calendar month",
                "rankingRelevance": "cross-sectional buckets within query",
                "oofEnsembleEnabled": enable_oof_ensemble,
                "oofOnlyMetaFit": True,
            },
            "dataAudit": data_audit,
            "knownLimitations": known_limitations,
        },
    )
    artifact.setdefault("methodology", {})["target"] = (
        "Rendimento totale rettificato per split e dividendi"
        if target_kind == "raw"
        else (
            "Rendimento neutralizzato point-in-time: raw - beta mercato * "
            "rendimento mercato - (rendimento settore - rendimento mercato)"
            if target_kind == "market-sector-neutral"
            else (
                f"Rendimento totale rettificato del titolo meno benchmark "
                f"({target_kind}; sottrazione aritmetica, senza beta hedge)"
            )
        )
    )
    _write_json_atomic(output_path, artifact)

    if args.dataset_output:
        dataset_path = Path(args.dataset_output).resolve()
        dataset_path.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(all_samples).to_csv(dataset_path, index=False)

    print(f"\nArtifact salvato: {output_path}")
    print(f"Campioni: {len(all_samples)} | Emittenti inclusi: {len(included)}")
    for horizon, model in artifact["models"].items():
        metrics = model["performance"]
        print(
            f"{horizon}: {model.get('modelDisplayName')} "
            f"OOS n={metrics.get('sampleSize')} "
            f"R2/zero={metrics.get('oosR2VsZero')} "
            f"MAE={metrics.get('mae')} "
            f"pubblicabile={model.get('publishable')}"
        )
        for algorithm, candidate in (
            model.get("candidatePerformance") or {}
        ).items():
            candidate_metrics = candidate.get("performance") or {}
            print(
                f"  - {algorithm}: "
                f"MAE={candidate_metrics.get('mae')} "
                f"R2/zero={candidate_metrics.get('oosR2VsZero')} "
                f"RankIC={candidate_metrics.get('rankIc')}"
            )
    return artifact


class _ExplicitTargetAction(argparse.Action):
    """Mantiene il valore legacy visibile ma distingue un override esplicito."""

    def __call__(self, parser, namespace, values, option_string=None):
        setattr(namespace, self.dest, values)
        setattr(namespace, "target_kind_explicit", True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Training point-in-time del modello fondamentale",
    )
    parser.set_defaults(target_kind_explicit=False)
    parser.add_argument(
        "--data-profile",
        choices=("v4", "v5"),
        default="v5",
        help=(
            "v5 abilita universo/security master PIT, target neutralizzato e "
            "feature market/event; v4 conserva il percorso legacy."
        ),
    )
    parser.add_argument(
        "--tickers",
        help="Elenco separato da virgole; default: universo diversificato incluso nello script.",
    )
    parser.add_argument("--limit", type=int, help="Limita il numero di ticker.")
    parser.add_argument(
        "--universe-source",
        choices=("security-master", "tickers", "legacy-default"),
        default="security-master",
        help="Fonte dell'universo; v5 non usa implicitamente la lista current-only.",
    )
    parser.add_argument(
        "--universe-size",
        type=int,
        default=2000,
        help="Numero massimo di emittenti (1-3000; default 2000).",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(DEFAULT_CACHE_DIR),
        help="Cache SEC/Yahoo locale.",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="Percorso dell'artifact JSON.",
    )
    parser.add_argument(
        "--dataset-output",
        help="CSV opzionale degli snapshot per audit.",
    )
    parser.add_argument(
        "--filing-frequency",
        choices=("annual", "quarterly"),
        default="annual",
        help=(
            "annual usa solo 10-K (default backward-compatible); quarterly "
            "abilita 10-K + 10-Q con flussi TTM point-in-time."
        ),
    )
    parser.add_argument(
        "--target-kind",
        choices=(
            "raw",
            "excess",
            "market-relative",
            "sector-relative",
            "market-sector-neutral",
        ),
        default="raw",
        action=_ExplicitTargetAction,
        help=(
            "Override esplicito. Senza questo flag il profilo v5 usa "
            "market-sector-neutral; v4 usa raw. Il raw resta sempre salvato."
        ),
    )
    parser.add_argument(
        "--market-benchmark",
        help="Ticker del benchmark richiesto da --target-kind market-relative.",
    )
    parser.add_argument(
        "--sector-benchmark",
        help="Ticker del benchmark richiesto da --target-kind sector-relative.",
    )
    parser.add_argument(
        "--excess-benchmark",
        help=(
            "Ticker cash/risk-free proxy richiesto da --target-kind excess; "
            "la pipeline applica una sottrazione aritmetica, non beta hedge."
        ),
    )
    parser.add_argument(
        "--security-master",
        help=(
            "CSV/JSON schema security-master-v5.1: una riga per alias/intervallo; "
            "security_id, ticker, canonical_ticker, valid_from/to, CIK, sector, "
            "SIC e sector_benchmark. delist_date/return opzionali."
        ),
    )
    parser.add_argument(
        "--sector-benchmark-map",
        help=(
            "CSV/JSON PIT opzionale con sector o SIC, benchmark, valid_from/to; "
            "completa sector_benchmark senza modificare la classificazione storica."
        ),
    )
    parser.add_argument(
        "--market-events",
        help=(
            "CSV/JSON earnings PIT opzionale. days_to richiede announced_at; "
            "surprise richiede published_at."
        ),
    )
    parser.add_argument(
        "--estimate-revisions",
        help=(
            "CSV/JSON revisioni stime PIT opzionale; published_at e "
            "revision_30d_pct sono richiesti per valorizzare la feature."
        ),
    )
    parser.add_argument(
        "--enable-market-features",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Abilita feature prezzo/volume/evento (default: si nel profilo v5).",
    )
    parser.add_argument(
        "--max-filing-age-days",
        type=int,
        help="Override opzionale della stale window (default 550 per 10-K, 190 per 10-Q).",
    )
    parser.add_argument("--alpha", type=float, default=12.0)
    parser.add_argument(
        "--algorithms",
        default="ridge,xgboost,lightgbm,catboost",
        help=(
            "Challenger separati da virgola. Ridge viene sempre mantenuto "
            "come benchmark e fallback."
        ),
    )
    parser.add_argument(
        "--ranking-horizons",
        default="3m",
        help=(
            "Orizzonti LambdaMART XGBoost/LightGBM separati da virgola; "
            "default 3m. Query=stesso mese snapshot."
        ),
    )
    parser.add_argument(
        "--enable-oof-ensemble",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Ensemble solo da predizioni temporali OOF (default: si in v5).",
    )
    parser.add_argument(
        "--tree-rounds",
        type=int,
        default=240,
        help="Numero di iterazioni per XGBoost e LightGBM.",
    )
    parser.add_argument(
        "--tree-loss-profile",
        choices=("squared_error", "huber", "quantile"),
        default="squared_error",
        help=(
            "Loss comune per XGBoost/LightGBM; squared_error conserva il "
            "comportamento predefinito."
        ),
    )
    parser.add_argument(
        "--quantile-alpha",
        type=float,
        help=(
            "Quantile da stimare, strettamente tra 0 e 1; valido soltanto "
            "con --tree-loss-profile quantile (default quantile: 0.5)."
        ),
    )
    parser.add_argument(
        "--early-stopping-rounds",
        type=int,
        default=40,
        help=(
            "Round senza miglioramento sul blocco temporale di validation; "
            "0 disabilita l'early stopping, default 40."
        ),
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--evaluation-years",
        type=int,
        default=2,
        help=(
            "Numero di anni finali esclusi dalla selezione e usati solo "
            "per conferma e metriche pubblicate."
        ),
    )
    parser.add_argument("--minimum-training-rows", type=int, default=120)
    parser.add_argument("--minimum-test-rows", type=int, default=20)
    parser.add_argument(
        "--offline",
        action="store_true",
        help=(
            "Vieta ogni download: usa solo cache SEC/prezzi esistente e "
            "fallisce chiaramente se manca un file."
        ),
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Aggiorna anche la cache SEC.",
    )
    parser.add_argument(
        "--refresh-prices",
        action="store_true",
        help="Aggiorna la cache prezzi.",
    )
    return parser


if __name__ == "__main__":
    train(build_parser().parse_args())
