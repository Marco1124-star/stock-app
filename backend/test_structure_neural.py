"""Offline regression tests; synthetic fixtures are not evidence of predictive edge."""
import copy
import importlib
import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from ml import structure_neural as neural
from ml.page_structure import calculate_supply_demand_zones


OPTIONS = {"strength": 70, "min_pct": 1, "gap_pct": .6}


def history(n=1100):
    index = pd.bdate_range(end=pd.Timestamp.now().normalize() - pd.Timedelta(days=1), periods=n)
    rng = np.random.default_rng(2026)
    close = 100 * np.exp(np.cumsum(rng.normal(.0002, .024, n)))
    opening = close * np.exp(rng.normal(0, .008, n))
    return pd.DataFrame({"Open": opening, "High": np.maximum(opening, close) * 1.003,
                         "Low": np.minimum(opening, close) * .997, "Close": close,
                         "Volume": rng.integers(10000, 100000, n).astype(float), "Adj Close": close}, index=index)


def payload(frame):
    gaps = neural.open_gaps_at(frame, neural.detect_gaps(frame), len(frame) - 1)
    return {"timeframe": "1d", "horizon": 1, **OPTIONS,
            "snapshot": {"asOf": frame.index[-1].date().isoformat(), "price": float(frame.Close.iloc[-1]), "gapWindowBars": len(frame),
                         "zones": neural.page_zones(frame, OPTIONS),
                         "gaps": [{k: g[k] for k in ("id", "date", "type", "start", "end", "fillPct")} for g in gaps]}}


def original_zones(frame, pivot_source):
    """Independent original scalar loop, including signed ADL / empty bins."""
    frame = frame.copy().ffill()
    edges = np.linspace(frame.Low.min(), frame.High.max(), 51)
    span = (frame.High - frame.Low).replace(0, 1e-9)
    adl = (((frame.Close - frame.Low) - (frame.High - frame.Close)) / span * frame.Volume).cumsum()
    support, resistance = np.zeros(50), np.zeros(50)
    for i in range(2, len(frame) - 2):
        position = min(49, max(0, np.digitize(frame.Close.iloc[i], edges) - 1))
        sample = frame.iloc[i-2:i+3]
        if pivot_source == "hilo":
            if frame.Low.iloc[i] == sample.Low.min():
                support[position] += adl.iloc[i]
            if frame.High.iloc[i] == sample.High.max():
                resistance[position] += adl.iloc[i]
        elif frame.Close.iloc[i] == sample.Close.min():
            support[position] += adl.iloc[i]
        elif frame.Close.iloc[i] == sample.Close.max():
            resistance[position] += adl.iloc[i]
    return {name: [{"price": round(float((edges[i] + edges[i+1]) / 2), 2),
                   "min": round(edges[i], 2), "max": round(edges[i+1], 2)}
                  for i in range(50) if counts[i] >= np.percentile(counts, 70)]
            for name, counts in (("support", support), ("resistance", resistance))}


class GeometryTests(unittest.TestCase):
    def test_vectorized_zones_preserve_original_daily_weekly_and_flat_rules(self):
        random = history(120)
        flat = random.copy()
        flat[["Open", "High", "Low", "Close"]] = 100.
        negative = random.copy()
        negative["Close"] = negative.Low
        missing = random.copy()
        missing.iloc[8:10] = np.nan
        for source in ("close", "hilo"):
            for frame in (random, flat, negative, missing, random.head(3)):
                with self.subTest(source=source, size=len(frame)):
                    self.assertEqual(calculate_supply_demand_zones(frame, strength_percentile=70, pivot_source=source),
                                     original_zones(frame, source))

    def test_gap_formation_fill_and_incremental_snapshots(self):
        frame = pd.DataFrame({"Open": [99, 104, 108, 105], "High": [101, 108, 112, 106],
                              "Low": [98, 103, 107, 102], "Close": [100, 107, 110, 103]},
                             index=pd.bdate_range("2025-01-01", periods=4))
        events = neural.detect_gaps(frame)
        standard = next(g for g in events if g["type"] == "Gap Up")
        self.assertEqual((standard["index"], standard["start"], standard["end"]), (1, 101., 103.))
        self.assertEqual(neural.fill_pct(standard, frame.iloc[2:3]), 0.)
        self.assertEqual(neural.fill_pct(standard, frame.iloc[3:]), 50.)
        self.assertTrue(any(g["type"] == "Gap Up 3 candele" for g in events))
        self.assertIn(standard["id"], [g["id"] for g in neural.open_gaps_at(frame, events, 1)])
        self.assertNotIn(standard["id"], [g["id"] for g in neural.open_gaps_at(frame, events, 3)])
        random = history(1400)
        events = neural.detect_gaps(random)
        snapshots = dict(neural.gap_snapshots(random, events, 0, len(random)))
        for t in (0, 1, 100, 250, 1305, 1399):
            expected = neural.candidates(neural.open_gaps_at(random, events, t), random.Close.iloc[t])
            self.assertEqual(snapshots[t], expected)
        # No gap older than the five-year source window is admitted.
        self.assertTrue(all(random.index[g["origin"]] >= random.index[-1] - pd.DateOffset(years=5)
                            for g in snapshots[1399]))
        snapshots = dict(neural.gap_snapshots(random, events, 1399, 1400, max_bars=260))
        expected = [g for g in neural.open_gaps_at(random, events, 1399) if g["origin"] >= 1140]
        self.assertEqual(snapshots[1399], neural.candidates(expected, random.Close.iloc[-1]))

    def test_feature_rows_do_not_change_when_future_prices_change(self):
        frame = history(300)
        altered = frame.copy()
        altered.loc[altered.index[255]:, ["Open", "High", "Low", "Close", "Adj Close"]] *= 4
        original = neural.dataset(frame, 5, OPTIONS)
        future = neural.dataset(altered, 5, OPTIONS)
        for kind in ("trend", "gaps"):
            x, y, times = original[kind]
            x2, y2, times2 = future[kind]
            np.testing.assert_array_equal(times[times + 5 < 255], times2[times2 + 5 < 255])
            np.testing.assert_allclose(x[times + 5 < 255], x2[times2 + 5 < 255])
            np.testing.assert_array_equal(y[times + 5 < 255], y2[times2 + 5 < 255])

    def test_adjusted_close_drives_labels_and_missing_labels_are_not_fabricated(self):
        frame = history(280)
        frame["Adj Close"] = 100.
        data = neural.dataset(frame, 5, OPTIONS)
        self.assertTrue((data["trend"][1] == 1).all())
        frame["Adj Close"] = np.nan
        self.assertEqual(len(neural.dataset(frame, 5, OPTIONS)["trend"][0]), 0)


class ModelTests(unittest.TestCase):
    def test_network_is_fitted_and_predictions_are_normalized(self):
        rng = np.random.default_rng(10)
        x = rng.normal(size=(600, 9))
        y = np.digitize(x[:, 0], [-.4, .4])
        fitted = neural.fit_network(x, y)
        self.assertEqual(fitted[0].hidden_layer_sizes, (16, 8))
        self.assertTrue(fitted[-1])
        before = fitted[1].mean_.copy()
        predicted = neural.predict_network(fitted, np.full((2, 9), 1e6), 3)
        np.testing.assert_allclose(predicted.sum(axis=1), 1)
        np.testing.assert_array_equal(fitted[1].mean_, before)
        np.testing.assert_allclose(fitted[2], np.quantile(x, .01, axis=0))

    def test_holdout_is_purged_and_scaler_never_sees_holdout_on_validation_fit(self):
        rng = np.random.default_rng(8)
        x = rng.normal(size=(1000, 9))
        y = np.digitize(x[:, 0], [-.4, .4])
        times = np.arange(1000)
        dates = pd.bdate_range("2020-01-01", periods=1010)
        with patch.object(neural, "fit_network", wraps=neural.fit_network) as fit:
            report, estimates = neural.train_task((x, y, times), x[-1:], 5, 700, 3, dates)
        self.assertIn(report["status"], ("validated", "experimental"))
        self.assertEqual(report["validation"]["windows"], 50)
        self.assertLess(report["validation"]["trainLabelEnd"], report["validation"]["start"])
        self.assertTrue(any(np.array_equal(call.args[0], x[:695]) for call in fit.call_args_list))
        np.testing.assert_array_equal(fit.call_args_list[-1].args[0], x)
        for fold in report["modelSelection"]["foldAudit"]:
            self.assertLess(fold["trainLabelEnd"], fold["start"])
            self.assertLess(fold["end"], report["validation"]["start"])
        self.assertAlmostEqual(report["validation"]["errorPct"] + report["validation"]["accuracyPct"], 100)
        self.assertEqual(estimates.shape, (1, 3))

    def test_insufficient_classes_and_nonconvergence_do_not_emit_estimates(self):
        times = np.arange(1000)
        x = np.ones((1000, 9))
        dates = pd.bdate_range("2020-01-01", periods=1010)
        for labels, mock in ((np.zeros(1000, int), False), (times % 3, True)):
            with patch.object(neural, "fit_network", return_value=(None, None, None, None, False)) as fit:
                result, estimates = neural.train_task((x, labels, times), x[-1:], 5, 700, 3, dates)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(estimates)
                self.assertEqual(fit.called, mock)

    def test_end_to_end_real_networks_preserve_page_inputs(self):
        frame = history()
        request = payload(frame)
        result = neural.build_structure_neural(frame, request)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["pageSnapshot"]["zones"], request["snapshot"]["zones"])
        self.assertEqual(result["inputSummary"]["price"], frame.Close.iloc[-1])
        self.assertIn(result["trend"]["status"], ("validated", "experimental"))
        self.assertAlmostEqual(sum(result["trend"]["probabilities"].values()), 100)
        current_ids = {g["id"] for g in request["snapshot"]["gaps"]}
        self.assertLessEqual(len(result["gaps"]["candidates"]), 8)
        self.assertTrue(all(g["id"] in current_ids for g in result["gaps"]["candidates"]))
        if result["gaps"]["status"] != "validated":
            self.assertIsNone(result["gaps"]["selectedId"])
        json.dumps(result, allow_nan=False)

    def test_stale_misaligned_and_insufficient_sources_are_explicit(self):
        frame = history()
        request = payload(frame)
        for source, change in ((frame.tail(200), {}), (frame.iloc[:-10], {}), (frame, {"price": 1}),
                               (frame, {"asOf": frame.index[-3].date().isoformat()})):
            body = copy.deepcopy(request)
            body["snapshot"].update(change)
            body["snapshot"]["gaps"] = [g for g in body["snapshot"]["gaps"] if g["date"] <= body["snapshot"]["asOf"]]
            with patch.object(neural, "dataset") as build:
                result = neural.build_structure_neural(source, body)
                self.assertEqual(result["status"], "unavailable")
                build.assert_not_called()


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.import_module("app")
        cls.request = payload(history(150))

    def setUp(self):
        self.module.structure_neural_cache.clear()
        self.client = self.module.app.test_client()

    def test_invalid_requests_fail_before_provider_or_training(self):
        with patch.object(self.module, "_load_page_daily_source") as source:
            for body in (None, {}, {**self.request, "horizon": 252}, {**self.request, "timeframe": "1w"},
                         {**self.request, "strength": True}, {**self.request, "gap_pct": "nan"}):
                response = self.client.post("/stock/AAPL/structure-neural", json=body)
                self.assertEqual(response.status_code, 400)
            self.assertEqual(self.client.post("/stock/AAPL/structure-neural", data="x" * 300001).status_code, 413)
            source.assert_not_called()

    def test_cache_source_and_request_identity_and_lock_release(self):
        frame = history(150)
        frame.attrs["pageSourceId"] = "ENI.MI:test-source"
        stub = {"status": "unavailable", "version": neural.VERSION, "horizon": 5}
        with patch.object(self.module, "_load_page_daily_source", return_value=(frame, "ENI.MI", {"currency": "EUR"})), \
             patch.object(self.module, "build_structure_neural", return_value=stub) as build:
            for _ in range(2):
                response = self.client.post("/stock/ENI.MI/structure-neural", json=self.request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["currency"], "EUR")
            build.assert_called_once()
            changed = {**self.request, "timeframe": "1mo", "horizon": 21}
            self.assertEqual(self.client.post("/stock/ENI.MI/structure-neural", json=changed).status_code, 200)
            self.assertEqual(build.call_count, 2)
        with patch.object(self.module, "_load_page_daily_source", side_effect=RuntimeError("offline")):
            self.assertEqual(self.client.post("/stock/ENI.MI/structure-neural", json=self.request).status_code, 502)
        self.assertTrue(self.module.structure_neural_lock.acquire(blocking=False))
        try:
            self.assertEqual(self.client.post("/stock/ENI.MI/structure-neural", json=self.request).status_code, 429)
        finally:
            self.module.structure_neural_lock.release()


if __name__ == "__main__":
    unittest.main()
