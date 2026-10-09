"""Opt-in live HTTP smoke check against the locally running application.

Run: venv\Scripts\python.exe smoke_structure_neural.py --ticker ENI.MI --timeframe 1w
Downloads public market data; does not place orders or modify portfolios.
"""
import argparse
import json
import time
import urllib.parse
import urllib.request
import pandas as pd
from ml.structure_neural import detect_gaps, open_gaps_at, VERSION, TIMEFRAMES


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", default="ENI.MI")
    parser.add_argument("--timeframe", choices=tuple(TIMEFRAMES), default="1d")
    args = parser.parse_args()
    args.horizon = TIMEFRAMES[args.timeframe][0]
    symbol = args.ticker.upper()
    base = "http://127.0.0.1:5000/stock/" + urllib.parse.quote(symbol, safe="")

    def call(url, payload=None):
        request = urllib.request.Request(url, data=json.dumps(payload).encode() if payload else None,
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=240) as response:
            return json.load(response)

    started = time.perf_counter()
    zones = call(base + "/supply_demand?timeframe=" + args.timeframe)["zones"]
    print("Livelli ricevuti: " + args.timeframe, flush=True)
    chart = call(base + "?timeframe=1d")["ohlc"]
    frame = pd.DataFrame(chart).rename(columns={k: k.title() for k in ("open", "high", "low", "close")})
    frame.index = pd.to_datetime(frame.pop("date"))
    cutoff = pd.Timestamp.now().normalize() - pd.DateOffset(years=5)
    frame = frame.loc[frame.index >= cutoff]
    assert len(frame) > 2, "Insufficient page candles"
    gaps = open_gaps_at(frame, detect_gaps(frame), len(frame) - 1)
    snapshot = {"price": float(frame.Close.iloc[-1]), "asOf": frame.index[-1].date().isoformat(),
                "zones": zones, "gaps": [{k: g[k] for k in ("id", "date", "type", "start", "end", "fillPct")} for g in gaps],
                "gapWindowBars": len(frame)}
    request = {"timeframe": args.timeframe, "horizon": args.horizon, "snapshot": snapshot}
    print(f"Snapshot pagina: {len(frame)} barre, {len(gaps)} gap, dati al {snapshot['asOf']}", flush=True)
    submitted = time.perf_counter()
    job = call(base + "/structure-neural/jobs", request)
    print(f"Job {job['jobId']} accettato in {time.perf_counter() - submitted:.2f}s", flush=True)
    deadline = time.monotonic() + 660
    while job["status"] in ("queued", "running"):
        if time.monotonic() > deadline:
            raise TimeoutError("Live smoke exceeded job deadline")
        time.sleep(2)
        job = call(base + "/structure-neural/jobs/" + job["jobId"])
    assert job["status"] == "complete", job
    result = job["result"]
    assert result["version"] == VERSION
    assert result["requestedSymbol"] == symbol
    assert result["horizon"] == args.horizon
    assert result["timeframe"] == args.timeframe
    assert result["pageSnapshot"]["zones"] == zones
    assert result["pageSnapshot"]["price"] == snapshot["price"]
    if result["status"] == "ready":
        ids = {g["id"] for g in gaps}
        assert all(g["id"] in ids for g in result["gaps"]["candidates"])
        assert not result["gaps"]["selectedId"] or result["gaps"]["status"] == "validated"
        for task in (result["trend"], result["gaps"]):
            if task["status"] != "unavailable":
                assert "modelSelection" in task
                metrics = task["validation"]
                assert abs(metrics["accuracyPct"] + metrics["errorPct"] - 100) < 1e-8
                assert metrics["trainLabelEnd"] < metrics["start"]
        if result["gaps"]["selectedId"]:
            assert next(g for g in result["gaps"]["candidates"] if g["id"] == result["gaps"]["selectedId"])["usable"]
    json.dumps(result, allow_nan=False)
    cached = call(base + "/structure-neural/jobs", request)
    assert cached["result"] == result and cached["jobId"] == job["jobId"], "Identical request must reuse the job"
    print(json.dumps({"symbol": result["symbol"], "currency": result["currency"], "status": result["status"],
                      "horizon": args.horizon, "reason": result.get("reason"),
                      "trend": result.get("trend"), "gaps": result.get("gaps"),
                      "elapsedSeconds": round(time.perf_counter() - started, 2)}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
