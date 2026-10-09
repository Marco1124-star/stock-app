import json
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
import pandas as pd

from ml.point_in_time import (
    V5_MARKET_FEATURE_NAMES,
    audit_market_feature_leakage,
    build_market_event_features,
    build_monthly_samples,
    resolve_security_point_in_time,
)
from train_fundamental_model import (
    _build_model_configs,
    _fetch_security_prices,
    _load_security_master,
    _resolved_target_kind,
    _security_master_runtime_payload,
    build_parser,
)


def _prices(dates, start, end, *, volume=1_000_000.0):
    close = np.linspace(float(start), float(end), len(dates))
    return pd.DataFrame(
        {
            "Close": close,
            "Adj Close": close,
            "Volume": np.full(len(dates), float(volume)),
            "Stock Splits": np.zeros(len(dates)),
        },
        index=dates,
    )


def _vintage(accepted_at):
    return {
        "accessionNumber": "0000000001-23-000001",
        "form": "10-K",
        "filingFrequency": "annual",
        "acceptedAt": accepted_at,
        "acceptedAtIso": accepted_at.isoformat() + "Z",
        "reportDate": "2022-12-31",
        "acceptanceFallback": False,
        "metricCoverage": 0.9,
        "missingMetrics": [],
        "missingMetricCount": 0,
        "unitAudit": {"status": "ok", "currency": "USD"},
        "ttm": {"coverage": 0.9},
        "metrics": {
            "revenue": 1_000.0,
            "gross_profit": 500.0,
            "operating_income": 200.0,
            "net_income": 150.0,
            "operating_cash_flow": 180.0,
            "capital_expenditure": -40.0,
            "assets": 2_000.0,
            "equity": 1_000.0,
            "current_assets": 700.0,
            "current_liabilities": 350.0,
            "cash": 200.0,
            "receivables": 150.0,
            "shares_outstanding": 10_000_000.0,
        },
    }


class MarketEventFeatureTests(unittest.TestCase):
    def test_features_use_only_sources_available_at_snapshot(self):
        dates = pd.bdate_range("2023-01-02", periods=120)
        stock = _prices(dates, 100, 145, volume=2_000_000)
        market = _prices(dates, 100, 120, volume=5_000_000)
        snapshot = dates[-1]
        events = [
            {
                "event_date": (snapshot - pd.Timedelta(days=20)).date().isoformat(),
                "published_at": (snapshot - pd.Timedelta(days=20)).isoformat(),
                "surprise_pct": 0.12,
            },
            {
                "event_date": (snapshot + pd.Timedelta(days=15)).date().isoformat(),
                "announced_at": (snapshot - pd.Timedelta(days=5)).isoformat(),
            },
            {
                "event_date": (snapshot + pd.Timedelta(days=5)).date().isoformat(),
                "announced_at": (snapshot + pd.Timedelta(days=1)).isoformat(),
            },
        ]
        revisions = [
            {
                "published_at": (snapshot - pd.Timedelta(days=2)).isoformat(),
                "revision_30d_pct": 0.04,
            },
            {
                "published_at": (snapshot + pd.Timedelta(days=1)).isoformat(),
                "revision_30d_pct": 9.99,
            },
        ]

        result = build_market_event_features(
            stock,
            snapshot,
            market,
            shares_outstanding=20_000_000,
            earnings_events=events,
            estimate_revisions=revisions,
        )

        for name in (
            "momentum_1d",
            "momentum_20d",
            "realized_volatility_20d",
            "log_average_dollar_volume_20d",
            "turnover_20d",
            "market_beta_60d",
        ):
            self.assertIsNotNone(result[name], name)
            self.assertEqual(result[f"is_missing_{name}"], 0.0)
        self.assertEqual(result["days_since_earnings"], 20.0)
        self.assertEqual(result["days_to_earnings"], 15.0)
        self.assertEqual(result["earnings_surprise_pct"], 0.12)
        self.assertEqual(result["earnings_revision_30d_pct"], 0.04)
        self.assertEqual(result["future_source_records_rejected"], 2)
        self.assertFalse(result["feature_lookahead_detected"])
        audit = audit_market_feature_leakage(
            [{"ticker": "TEST", "snapshot_date": snapshot, **result}]
        )
        self.assertTrue(audit["passed"])

    def test_future_calendar_and_untimestamped_estimates_fail_closed(self):
        dates = pd.bdate_range("2024-01-02", periods=80)
        snapshot = dates[-1]
        result = build_market_event_features(
            _prices(dates, 100, 110),
            snapshot,
            earnings_events=[
                {
                    "event_date": (snapshot + pd.Timedelta(days=10)).date().isoformat(),
                    # Nessun announced_at: non era dimostrabilmente noto.
                },
                {
                    "event_date": (snapshot - pd.Timedelta(days=10)).date().isoformat(),
                    "surprise_pct": 0.5,
                    # Nessun published_at: surprise non utilizzabile.
                },
            ],
            estimate_revisions=[{"revision_30d_pct": 0.8}],
        )
        self.assertIsNone(result["days_to_earnings"])
        self.assertIsNone(result["earnings_surprise_pct"])
        self.assertIsNone(result["earnings_revision_30d_pct"])
        self.assertEqual(result["is_missing_days_to_earnings"], 1.0)


class NeutralTargetTests(unittest.TestCase):
    def test_market_sector_neutral_target_uses_asof_beta_and_sector_mapping(self):
        dates = pd.bdate_range("2023-01-02", periods=420)
        stock = _prices(dates, 100, 180, volume=2_000_000)
        market = _prices(dates, 100, 135, volume=5_000_000)
        sector = _prices(dates, 100, 150, volume=3_000_000)
        security = [
            {
                "security_id": "CIK:0000000001",
                "ticker": "TEST",
                "canonical_ticker": "TEST",
                "valid_from": "2020-01-01",
                "valid_to": None,
                "sector": "Technology",
                "sic": "7372",
                "sector_benchmark": "XLK",
            }
        ]
        rows = build_monthly_samples(
            "TEST",
            [_vintage(datetime(2023, 3, 1))],
            stock,
            benchmark_prices={"market": market},
            benchmark_symbols={"market": "SPY"},
            sector_benchmark_prices={"XLK": sector},
            target_kind="market-sector-neutral",
            security_timeline=security,
            enable_market_features=True,
        )
        usable = next(
            row
            for row in rows
            if row["target_3m"] is not None and row["market_beta_60d"] is not None
        )
        expected = (
            usable["target_raw_3m"]
            - usable["market_beta_60d"] * usable["benchmark_return_market_3m"]
            - (
                usable["benchmark_return_sector_3m"]
                - usable["benchmark_return_market_3m"]
            )
        )
        self.assertAlmostEqual(usable["target_3m"], expected)
        self.assertAlmostEqual(
            usable["target_market_sector_neutral_3m"], expected
        )
        self.assertEqual(usable["benchmark_symbol_sector"], "XLK")
        self.assertEqual(usable["security_sic"], "7372")
        self.assertFalse(usable["feature_lookahead_detected"])
        for name in V5_MARKET_FEATURE_NAMES:
            self.assertIn(f"is_missing_{name}", usable)

    def test_delisting_return_prevents_survivorship_label_censoring(self):
        dates = pd.bdate_range("2024-01-02", "2024-04-10")
        prices = _prices(dates, 100, 80)
        security = [
            {
                "security_id": "DELISTED-1",
                "ticker": "OLD",
                "canonical_ticker": "OLD",
                "valid_from": "2020-01-01",
                "valid_to": "2024-04-10",
                "delist_date": "2024-04-10",
                "delisting_return": -0.5,
            }
        ]
        rows = build_monthly_samples(
            "OLD",
            [_vintage(datetime(2024, 1, 3))],
            prices,
            target_kind="raw",
            security_timeline=security,
        )
        terminal = next(
            row
            for row in rows
            if row.get("target_includes_delisting_return_1m")
        )
        self.assertIsNotNone(terminal["target_raw_1m"])
        self.assertLess(terminal["target_raw_1m"], -0.4)
        self.assertGreater(terminal["label_date_1m"], "2024-04-10")


class SecurityMasterV5Tests(unittest.TestCase):
    def test_aliases_resolve_point_in_time_and_runtime_payload_is_portable(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "security-master.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "security-master-v5.1",
                        "securities": [
                            {
                                "security_id": "CIK:0000000123",
                                "ticker": "OLD",
                                "canonical_ticker": "NEW",
                                "valid_from": "2010-01-01",
                                "valid_to": "2020-12-31",
                                "cik": 123,
                                "sector": "Technology",
                                "sic": "7372",
                                "sector_benchmark": "XLK",
                            },
                            {
                                "security_id": "CIK:0000000123",
                                "ticker": "NEW",
                                "canonical_ticker": "NEW",
                                "valid_from": "2021-01-01",
                                "cik": 123,
                                "sector": "Technology",
                                "sic": "7372",
                                "sector_benchmark": "XLK",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            lookup, audit = _load_security_master(str(path))

        self.assertEqual(list(lookup), ["NEW"])
        self.assertEqual(
            resolve_security_point_in_time(lookup["NEW"], "2020-06-01")["ticker"],
            "OLD",
        )
        self.assertEqual(
            resolve_security_point_in_time(lookup["NEW"], "2022-06-01")["ticker"],
            "NEW",
        )
        self.assertEqual(audit["schemaVersion"], "security-master-v5.1")
        self.assertNotIn("sourcePath", audit)
        runtime = _security_master_runtime_payload(lookup)
        self.assertEqual(runtime["issuers"][0]["canonicalTicker"], "NEW")
        self.assertEqual(
            [item["ticker"] for item in runtime["issuers"][0]["aliases"]],
            ["OLD", "NEW"],
        )

    def test_overlaps_are_rejected_by_security_id_and_ticker(self):
        records = {
            "securities": [
                {
                    "security_id": "S1",
                    "ticker": "ONE",
                    "valid_from": "2020-01-01",
                    "valid_to": "2021-12-31",
                },
                {
                    "security_id": "S1",
                    "ticker": "TWO",
                    "valid_from": "2021-01-01",
                },
            ]
        }
        with TemporaryDirectory() as directory:
            path = Path(directory) / "overlap.json"
            path.write_text(json.dumps(records), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "intervalli sovrapposti"):
                _load_security_master(str(path))

    def test_alias_price_caches_are_stitched_without_network(self):
        with TemporaryDirectory() as directory:
            cache = Path(directory)
            price_dir = cache / "prices"
            price_dir.mkdir(parents=True)
            old_dates = pd.bdate_range("2020-12-20", "2020-12-31")
            new_dates = pd.bdate_range("2021-01-01", "2021-01-15")
            _prices(old_dates, 90, 100).to_csv(price_dir / "OLD.csv")
            _prices(new_dates, 101, 110).to_csv(price_dir / "NEW.csv")
            combined = _fetch_security_prices(
                "NEW",
                [
                    {
                        "ticker": "OLD",
                        "price_ticker": "OLD",
                        "valid_from": "2020-01-01",
                        "valid_to": "2020-12-31",
                    },
                    {
                        "ticker": "NEW",
                        "price_ticker": "NEW",
                        "valid_from": "2021-01-01",
                        "valid_to": None,
                    },
                ],
                cache,
                start="2020-01-01",
                refresh=False,
                offline=True,
            )
        self.assertEqual(combined.index.min().date().isoformat(), "2020-12-21")
        self.assertEqual(combined.index.max().date().isoformat(), "2021-01-15")
        self.assertEqual(set(combined["Security Ticker"]), {"OLD", "NEW"})


class V5CliContractTests(unittest.TestCase):
    def test_v5_defaults_resolve_neutral_but_explicit_raw_remains_available(self):
        parser = build_parser()
        default = parser.parse_args([])
        legacy = parser.parse_args(["--data-profile", "v4"])
        explicit_raw = parser.parse_args(["--target-kind", "raw"])
        self.assertEqual(default.target_kind, "raw")  # contratto CLI v4 visibile
        self.assertEqual(_resolved_target_kind(default), "market-sector-neutral")
        self.assertEqual(_resolved_target_kind(legacy), "raw")
        self.assertEqual(_resolved_target_kind(explicit_raw), "raw")
        self.assertEqual(default.universe_size, 2000)
        self.assertEqual(default.universe_source, "security-master")
        self.assertEqual(default.ranking_horizons, "3m")
        self.assertIn("catboost", default.algorithms)

    def test_catboost_is_configured_as_ordered_robust_challenger(self):
        args = build_parser().parse_args([])
        configs = _build_model_configs(args)
        self.assertEqual(configs["catboost"]["robust_profile"], "huber")
        self.assertEqual(configs["catboost"]["depth"], 5)
        self.assertEqual(configs["catboost"]["learning_rate"], 0.03)


if __name__ == "__main__":
    unittest.main()
