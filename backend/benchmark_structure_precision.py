"""Explicit live-data benchmark; reports successes AND failures without tuning to test.

No portfolio writes or orders. Downloads only requested public price histories.
Run from backend: venv\Scripts\python.exe benchmark_structure_precision.py --tickers ENI.MI AAPL
"""
import argparse
import json
import time
from app import _load_page_daily_source
from ml.structure_neural import build_structure_neural, page_zones, detect_gaps, open_gaps_at, VERSION, TIMEFRAMES


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tickers", nargs="+", default=["ENI.MI", "AAPL"])
    parser.add_argument("--horizons", nargs="+", type=int, choices=(1, 5, 21), default=[1, 5, 21])
    args = parser.parse_args()
    options = {"strength": 70, "min_pct": 1, "gap_pct": .6}
    for ticker in args.tickers:
        frame, symbol, meta = _load_page_daily_source(ticker)
        if frame.empty:
            print(json.dumps({"ticker": ticker, "status": "unavailable", "reason": "No public history"}), flush=True)
            continue
        chart = frame.tail(260)
        gaps = open_gaps_at(chart, detect_gaps(chart), len(chart) - 1)
        snapshot = {"price": float(chart.Close.iloc[-1]), "asOf": chart.index[-1].date().isoformat(),
                    "zones": page_zones(frame, options), "gaps": gaps, "gapWindowBars": len(chart)}
        print(json.dumps({"ticker": symbol, "sourceId": frame.attrs.get("pageSourceId"), "observedBars": len(frame),
                          "asOf": snapshot["asOf"], "currency": meta.get("currency"), "version": VERSION}), flush=True)
        for horizon in args.horizons:
            start = time.perf_counter()
            timeframe = {1: "1d", 5: "1w", 21: "1mo"}[horizon]
            _, _, strength, distance, gap = TIMEFRAMES[timeframe]
            options = {"timeframe": timeframe, "strength": strength, "min_pct": distance, "gap_pct": gap}
            snapshot["zones"] = page_zones(frame, options)
            result = build_structure_neural(frame, {"snapshot": snapshot, "horizon": horizon, **options})
            tasks = {}
            for name in ("trend", "gaps"):
                task = result.get(name, {})
                validation = task.get("validation", {})
                before, after = validation.get("incumbentBrier"), validation.get("brier")
                tasks[name] = {"status": task.get("status"), "reason": task.get("reason"),
                               "modelSelection": task.get("modelSelection"), "validation": validation,
                               "brierReductionVsV1Pct": (1 - after / before) * 100 if before and after is not None else None}
            print(json.dumps({"ticker": symbol, "horizon": horizon, "status": result["status"], "reason": result.get("reason"),
                              "elapsedSeconds": round(time.perf_counter() - start, 2), "tasks": tasks}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
