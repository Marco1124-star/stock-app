"""Regression tests for timing, data availability and heatmap forecast decisions.

All fixtures are synthetic and deterministic.  No provider, Flask application or
network is imported, so these checks exercise the forecasting contract directly.
"""

import json
import unittest

import numpy as np
import pandas as pd

try:
    from ml.heatmap_signal import build_heatmap_signal, prepare_signal_dataset
except ModuleNotFoundError as exc:
    if exc.name not in {"ml", "ml.heatmap_signal"}:
        raise
    from backend.ml.heatmap_signal import build_heatmap_signal, prepare_signal_dataset


def _prices(returns, dates, initial=100.0):
    return pd.Series(initial * np.cumprod(1.0 + np.asarray(returns)), index=dates)


def _fixture(periods=850, seed=732):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(end="2026-09-08", periods=periods)
    sector_returns = rng.normal(0.0002, 0.008, periods)
    market_returns = 0.65 * sector_returns + rng.normal(0.0, 0.005, periods)
    target_returns = 0.85 * sector_returns + rng.normal(0.0001, 0.01, periods)
    target = _prices(target_returns, dates)
    factors = {
        "Settore": _prices(sector_returns, dates),
        "Mercato": _prices(market_returns, dates),
    }
    return target, factors


def _learnable_fixture(direction, periods=1100):
    """Slow sector cycles transmit to the next day's stock return.

    The last observation is near a sector peak/trough.  Persistence makes the
    target return after the one-session entry delay learnable from past data.
    Independent stock noise prevents a tautological copy of the feature vector.
    """
    dates = pd.bdate_range(end="2026-09-08", periods=periods)
    position = np.arange(periods)
    sector_returns = direction * 0.012 * np.cos(
        2 * np.pi * (position - (periods - 1)) / 120
    )
    stock_returns = 1.6 * np.roll(sector_returns, 1)
    stock_returns += np.random.default_rng(25).normal(0, 0.0006, periods)
    return _prices(stock_returns, dates), {"Settore": _prices(sector_returns, dates)}


class ForwardDatasetTimingTests(unittest.TestCase):
    def test_labels_use_next_session_entry_and_exact_holding_horizon(self):
        target, factors = _fixture()
        for horizon, sessions in (("daily", 1), ("monthly", 21), ("annual", 252)):
            with self.subTest(horizon=horizon):
                dataset = prepare_signal_dataset(
                    target, factors, horizon, "Settore", as_of=target.index[-1]
                )
                self.assertEqual(dataset["horizonSessions"], sessions)
                expected = target.shift(-(sessions + 1)).div(target.shift(-1)).sub(1)
                actual = dataset["labels"].dropna()
                self.assertGreater(len(actual), 20)
                np.testing.assert_allclose(
                    actual.to_numpy(), expected.reindex(actual.index).to_numpy(),
                    rtol=1e-11, atol=1e-12,
                )
                date_series = pd.Series(target.index, index=target.index)
                pd.testing.assert_series_equal(
                    pd.to_datetime(dataset["entryDate"].reindex(actual.index)),
                    date_series.shift(-1).reindex(actual.index), check_names=False,
                )
                pd.testing.assert_series_equal(
                    pd.to_datetime(dataset["labelEnd"].reindex(actual.index)),
                    date_series.shift(-(sessions + 1)).reindex(actual.index),
                    check_names=False,
                )

    def test_historical_features_do_not_change_when_future_prices_change(self):
        target, factors = _fixture()
        cutoff = target.index[620]
        changed_target = target.copy()
        changed_target.loc[changed_target.index > cutoff] *= np.linspace(
            1.1, 50, (changed_target.index > cutoff).sum()
        )
        changed_factors = {name: series.copy() for name, series in factors.items()}
        for series in changed_factors.values():
            series.loc[series.index > cutoff] *= 11.0
        before = prepare_signal_dataset(
            target, factors, "monthly", "Settore", as_of=target.index[-1]
        )["features"]
        after = prepare_signal_dataset(
            changed_target, changed_factors, "monthly", "Settore", as_of=target.index[-1]
        )["features"]
        historical_dates = before.index.intersection(after.index)
        historical_dates = historical_dates[historical_dates <= cutoff]
        self.assertGreater(len(historical_dates), 100)
        pd.testing.assert_frame_equal(
            before.loc[historical_dates], after.loc[historical_dates],
            check_exact=False, rtol=1e-10, atol=1e-12,
        )

    def test_as_of_matches_physically_truncated_inputs(self):
        target, factors = _fixture()
        cutoff = target.index[620]
        snapshot = prepare_signal_dataset(
            target, factors, "monthly", "Settore", as_of=cutoff
        )
        prefix = prepare_signal_dataset(
            target.loc[:cutoff], {name: values.loc[:cutoff] for name, values in factors.items()},
            "monthly", "Settore", as_of=cutoff,
        )
        self.assertLessEqual(snapshot["features"].index.max(), cutoff)
        for field in ("features", "labels", "labelEnd", "entryDate"):
            with self.subTest(field=field):
                if field == "features":
                    pd.testing.assert_frame_equal(snapshot[field], prefix[field])
                else:
                    pd.testing.assert_series_equal(snapshot[field], prefix[field])
        completed = pd.to_datetime(snapshot["labelEnd"].dropna())
        self.assertTrue((completed <= cutoff).all())


class ForwardSignalAvailabilityTests(unittest.TestCase):
    def assertUnavailable(self, payload):
        self.assertEqual(payload["action"], "unavailable")
        self.assertNotEqual(payload.get("label"), "Neutro")
        # API JSON must never contain JavaScript-invalid numeric values.
        json.dumps(payload, allow_nan=False)

    def test_no_prices_is_unavailable_instead_of_neutral(self):
        self.assertUnavailable(build_heatmap_signal(
            pd.Series(dtype=float), {}, "daily", as_of="2026-09-08"
        ))

    def test_missing_sector_reference_is_unavailable(self):
        target, factors = _fixture()
        self.assertUnavailable(build_heatmap_signal(
            target, {"Mercato": factors["Mercato"]}, "daily",
            as_of=target.index[-1],
        ))

    def test_stale_target_prices_are_unavailable(self):
        target, factors = _fixture()
        self.assertUnavailable(build_heatmap_signal(
            target, factors, "daily", as_of=target.index[-1] + pd.Timedelta(days=9)
        ))

    def test_sector_missing_latest_session_is_unavailable(self):
        target, factors = _fixture()
        factors["Settore"] = factors["Settore"].iloc[:-1]
        self.assertUnavailable(build_heatmap_signal(
            target, factors, "daily", as_of=target.index[-1]
        ))

    def test_nonfinite_prices_do_not_leak_nonfinite_json(self):
        target, factors = _fixture()
        target.iloc[-1] = np.inf
        payload = build_heatmap_signal(
            target, factors, "daily", as_of=target.index[-1]
        )
        json.dumps(payload, allow_nan=False)

    def test_five_years_of_annual_overlaps_do_not_imply_high_confidence(self):
        target, factors = _fixture(periods=1260)
        payload = build_heatmap_signal(
            target, factors, "annual", as_of=target.index[-1]
        )
        self.assertNotIn(str(payload.get("confidence")).casefold(), {"alta", "high"})
        self.assertNotIn(payload["action"], {"buy", "sell"})
        self.assertEqual(payload["status"], "insufficient_validation")
        self.assertLess(payload["validation"]["nonOverlappingObservations"], 8)
        self.assertIsNone(payload["upsideProbability"])
        json.dumps(payload, allow_nan=False)


class ForwardSignalEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.learnable = {}
        cls.signals = {}
        for direction in (1, -1):
            target, factors = _learnable_fixture(direction)
            cls.learnable[direction] = (target, factors)
            cls.signals[direction] = build_heatmap_signal(
                target, factors, "daily", as_of=target.index[-1]
            )

    def test_learnable_positive_and_negative_relationships_produce_distinct_actions(self):
        for direction, action in ((1, "buy"), (-1, "sell")):
            with self.subTest(direction=direction):
                signal = self.signals[direction]
                self.assertEqual(signal["action"], action, signal["reasons"])
                self.assertGreater(direction * signal["forecastReturnPct"], 0)
                self.assertGreater(signal["validation"]["skillVsBaseline"], 0)
                self.assertGreater(signal["validation"]["skillVsZero"], 0)
                json.dumps(signal, allow_nan=False)

    def test_every_training_label_matures_before_its_validation_window(self):
        for signal in self.signals.values():
            self.assertGreaterEqual(signal["validation"]["folds"], 3)
            for fold in signal["validation"]["foldAudit"]:
                self.assertLess(
                    pd.Timestamp(fold["trainLabelEnd"]),
                    pd.Timestamp(fold["validationStart"]),
                )

    def test_higher_costs_suppress_actions_without_changing_forecast(self):
        for direction in (1, -1):
            with self.subTest(direction=direction):
                target, factors = self.learnable[direction]
                low_cost = self.signals[direction]
                high_cost = build_heatmap_signal(
                    target, factors, "daily", cost_bps=500, as_of=target.index[-1]
                )
                self.assertAlmostEqual(
                    low_cost["forecastReturnPct"], high_cost["forecastReturnPct"], places=12
                )
                self.assertGreater(
                    high_cost["decisionThresholdPct"], low_cost["decisionThresholdPct"]
                )
                self.assertEqual(high_cost["action"], "hold")

    def test_unpredictable_noise_cannot_claim_high_confidence(self):
        target, factors = _fixture(periods=1100)
        signal = build_heatmap_signal(
            target, factors, "daily", as_of=target.index[-1]
        )
        self.assertNotIn(str(signal["confidence"]).casefold(), {"alta", "high"})
        self.assertEqual(signal["action"], "hold")
        self.assertEqual(signal["status"], "no_edge")
        json.dumps(signal, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
