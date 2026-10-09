import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import pandas as pd
from ml.structure_features import page_feature_table, first_gap_event, path_event, volatility, PAGE_FEATURES
from ml.structure_jobs import StructureJobs
from test_structure_neural import history, payload


class FeatureTests(unittest.TestCase):
    def test_market_proxy_uses_listing_not_timezone(self):
        from ml.structure_worker import market_proxy
        self.assertEqual(market_proxy("ENI.MI", {"exchangeTimezoneName": "Europe/Zurich"}), "FTSEMIB.MI")
        self.assertEqual(market_proxy("NESN.SW", {"exchangeTimezoneName": "Europe/Zurich"}), "^SSMI")
        self.assertEqual(market_proxy("AAPL", {"exchangeName": "NMS"}), "^GSPC")
        self.assertIsNone(market_proxy("UNKNOWN", {"exchangeTimezoneName": "America/New_York"}))

    def test_market_features_never_use_same_day_or_future_close(self):
        frame = history(320)
        before = page_feature_table(frame, market=frame)
        changed = frame.copy()
        changed.iloc[270:] *= 4
        after = page_feature_table(frame, market=changed)
        np.testing.assert_allclose(before.iloc[:271], after.iloc[:271])
        self.assertEqual(before.market_missing.iloc[-1], 0.)

    def test_page_features_are_causal_and_missing_filings_explicit(self):
        frame = history(320)
        original = page_feature_table(frame)
        changed = frame.copy()
        changed.iloc[270:] *= 4
        future = page_feature_table(changed)
        np.testing.assert_allclose(original.iloc[:270], future.iloc[:270])
        self.assertEqual(list(original.columns), PAGE_FEATURES)
        self.assertTrue((original.missing_fundamental_gross_margin == 1).all())
        # Independent arithmetic check of the site's rolling RSI variant.
        delta = frame.Close.diff().tail(14)
        expected = delta.clip(lower=0).mean() / delta.abs().mean()
        self.assertAlmostEqual(original.technical_RSI14.iloc[-1], expected)

    def test_filing_not_visible_before_acceptance_or_same_day(self):
        frame = history(260)
        accepted = frame.index[240] + pd.Timedelta(hours=18)
        vintages = [{"accessionNumber": "x", "acceptedAt": accepted.to_pydatetime(), "reportDate": str(frame.index[210].date()),
                     "form": "10-K", "metrics": {"revenue": 100, "gross_profit": 40, "assets": 200}}]
        table = page_feature_table(frame, vintages)
        self.assertEqual(table.missing_fundamental_gross_margin.iloc[240], 1)
        self.assertEqual(table.missing_fundamental_gross_margin.iloc[241], 0)
        self.assertAlmostEqual(table.fundamental_gross_margin.iloc[241], .4)

    def test_volatility_does_not_use_future(self):
        frame = history(260)
        returns = frame["Adj Close"].pct_change().iloc[-20:]
        self.assertAlmostEqual(volatility(frame), np.std(returns, ddof=1))


class EventTests(unittest.TestCase):
    def setUp(self):
        self.gaps = [{"id": "up", "start": 109, "end": 111, "type": "Gap Down"},
                     {"id": "down", "start": 89, "end": 91, "type": "Gap Up"}]
        self.zones = {"support": [{"min": 85, "max": 87}], "resistance": [{"min": 113, "max": 115}]}

    def test_first_hit_and_none_and_ambiguity(self):
        future = pd.DataFrame({"High": [105, 111], "Low": [98, 95]})
        event = first_gap_event(self.gaps, future, 100, self.zones)
        self.assertEqual((event["winner"], event["steps"]), ("up", 2))
        self.assertIsNone(first_gap_event(self.gaps, future.iloc[:1], 100, self.zones)["winner"])
        both = pd.DataFrame({"High": [111], "Low": [89]})
        self.assertTrue(first_gap_event(self.gaps, both, 100, self.zones)["ambiguous"])
        target_and_stop = pd.DataFrame({"High": [111], "Low": [84]})
        self.assertTrue(first_gap_event(self.gaps[:1], target_and_stop, 100, self.zones)["ambiguous"])

    def test_invalidation_before_target_is_not_a_success(self):
        future = pd.DataFrame({"High": [105, 111], "Low": [84, 99]})
        event = first_gap_event(self.gaps[:1], future, 100, self.zones)
        self.assertIsNone(event["winner"])
        self.assertEqual(event["invalidated"], 1)
        self.assertEqual(path_event(pd.DataFrame({"High": [111], "Low": [89]}), 100, .1), -1)


class JobTests(unittest.TestCase):
    def test_job_routes_validate_and_return_without_training(self):
        import app
        request = payload(history(150))
        state = {"jobId": "abc", "status": "queued", "symbol": "AAPL", "result": None}
        client = app.app.test_client()
        with patch("ml.structure_jobs.jobs.submit", return_value=state) as submit, patch.object(app, "_load_page_daily_source") as loader:
            response = client.post("/stock/AAPL/structure-neural/jobs", json=request)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.get_json(), state)
            submit.assert_called_once_with("AAPL", request)
            loader.assert_not_called()
            self.assertEqual(client.post("/stock/AAPL/structure-neural/jobs", json={}).status_code, 400)
            self.assertEqual(submit.call_count, 1)
        with patch("ml.structure_jobs.jobs.get", return_value=None):
            self.assertEqual(client.get("/stock/MSFT/structure-neural/jobs/abc").status_code, 404)

    def test_nonblocking_deduplication_and_symbol_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = StructureJobs(directory)
            with patch.object(jobs.executor, "submit") as submit:
                first = jobs.submit("AAPL", payload(history(150)))
                repeated = jobs.submit("AAPL", payload(history(150)))
                self.assertEqual(first["jobId"], repeated["jobId"])
                submit.assert_called_once()
                self.assertEqual(first["status"], "queued")
                self.assertIsNone(jobs.get("MSFT", first["jobId"]))
                for symbol in ("B", "C"):
                    jobs.submit(symbol, {})
                with self.assertRaises(RuntimeError):
                    jobs.submit("D", {})
            jobs.executor.shutdown(wait=False)

    def test_worker_results_are_persisted_and_reused(self):
        from ml.structure_neural import VERSION
        with tempfile.TemporaryDirectory() as directory:
            jobs = StructureJobs(directory)
            job = {"jobId": "abc", "identity": "hash", "symbol": "AAPL", "status": "queued", "updated": 0}
            result = {"version": VERSION, "requestedSymbol": "AAPL", "status": "ready"}
            def run(command, **kwargs):
                Path(command[-1]).write_text(json.dumps(result), encoding="utf-8")
                self.assertEqual(kwargs["timeout"], 600)
                self.assertEqual(kwargs["env"]["OMP_NUM_THREADS"], "1")
            with patch("ml.structure_jobs.subprocess.run", side_effect=run) as worker:
                jobs._run(job, {})
                self.assertEqual(job["result"], result)
                jobs._run(job, {})
                worker.assert_called_once()
            jobs.executor.shutdown(wait=False)


if __name__ == "__main__":
    unittest.main()
