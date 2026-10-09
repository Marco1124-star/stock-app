"""Isolated entry point: never imported to start a server or create recursive jobs."""
import json
import os
import sys
import hashlib
from pathlib import Path
from datetime import datetime, timezone, timedelta


def market_proxy(symbol, metadata):
    # Several Yahoo European exchanges share Europe/Zurich. A timezone is NOT
    # a listing country; explicit exchange/suffix mapping takes precedence.
    suffixes = {".MI": "FTSEMIB.MI", ".SW": "^SSMI", ".L": "^FTSE", ".PA": "^FCHI",
                ".DE": "^GDAXI", ".F": "^GDAXI", ".T": "^N225", ".AS": "^AEX",
                ".MC": "^IBEX", ".TO": "^GSPTSE", ".HK": "^HSI", ".AX": "^AXJO"}
    for suffix, proxy in suffixes.items():
        if symbol.upper().endswith(suffix):
            return proxy
    exchanges = {"MIL": "FTSEMIB.MI", "EBS": "^SSMI", "LSE": "^FTSE", "PAR": "^FCHI", "GER": "^GDAXI", "JPX": "^N225"}
    exchange = metadata.get("exchangeName", "").upper()
    if exchange in {"NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"}:
        return "^GSPC"
    return exchanges.get(exchange)


def main():
    from app import (_fetch_chart_data, completed_daily_history, _json_safe,
                     _fetch_sec_companyfacts_payload, _fetch_sec_submissions_payload,
                     build_ml_filing_index, extract_ml_filing_vintages)
    from .structure_neural import build_structure_neural
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    symbol, payload = request["symbol"], request["payload"]
    # Exact instrument only: no substitutions to another exchange/share class.
    history, meta = _fetch_chart_data(symbol, "20y", "1d")
    if history.empty:
        history, meta = _fetch_chart_data(symbol, "10y", "1d")
    if history.empty:
        raise RuntimeError("Storico del ticker esatto non disponibile")
    # Preserve the observed current bar for inference; the builder alone
    # excludes incomplete sessions from training and aligns the page snapshot.
    history = completed_daily_history(history, datetime.now(timezone.utc) + timedelta(days=1))
    market_symbol = market_proxy(symbol, meta)
    market = None
    if market_symbol:
        market, _ = _fetch_chart_data(market_symbol, "20y", "1d")
        if not market.empty:
            market = completed_daily_history(market)
    vintages = []
    # US SEC filings are optional; foreign listings are not relabelled as US.
    if "." not in symbol and "=" not in symbol and not symbol.startswith("^"):
        facts = _fetch_sec_companyfacts_payload(symbol)
        submissions = _fetch_sec_submissions_payload(symbol)
        if facts and submissions:
            vintages = extract_ml_filing_vintages(facts, build_ml_filing_index(submissions, include_quarterly=True), include_quarterly=True)
    result = build_structure_neural(history, payload, vintages=vintages, market=market, market_symbol=market_symbol)
    result.update(symbol=symbol, requestedSymbol=symbol, currency=meta.get("currency"),
                  source="Yahoo Finance + formule delle pagine + filing SEC disponibili",
                  generatedAt=datetime.now(timezone.utc).isoformat(), workerPid=os.getpid(),
                  sourceId=hashlib.sha256(history.to_json(date_format="iso").encode()).hexdigest(),
                  sourceCoverageDates={"start": str(history.index[0].date()), "end": str(history.index[-1].date()), "bars": len(history), "filings": len(vintages)})
    output = Path(sys.argv[2])
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(_json_safe(result), allow_nan=False), encoding="utf-8")
    os.replace(temporary, output)


if __name__ == "__main__":
    main()
