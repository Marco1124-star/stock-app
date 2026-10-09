import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from datetime import datetime

import numpy as np
import pandas as pd

from ml.point_in_time import (
    build_filing_index,
    build_monthly_samples,
    extract_filing_vintages,
)
from train_fundamental_model import (
    _apply_security_master,
    _build_model_configs,
    _download_json,
    _load_security_master,
    build_parser,
)


def _fact(entries, unit="USD"):
    return {"units": {unit: entries}}


class QuarterlyPointInTimeTests(unittest.TestCase):
    annual_accession = "0000000001-24-000001"
    prior_quarter_accession = "0000000001-23-000002"
    current_quarter_accession = "0000000001-24-000003"
    amendment_accession = "0000000001-24-000004"

    def _submissions(self):
        return {
            "filings": {
                "recent": {
                    "accessionNumber": [
                        self.amendment_accession,
                        self.current_quarter_accession,
                        self.annual_accession,
                        self.prior_quarter_accession,
                    ],
                    "filingDate": [
                        "2024-05-10",
                        "2024-05-01",
                        "2024-02-15",
                        "2023-05-01",
                    ],
                    "reportDate": [
                        "2024-03-31",
                        "2024-03-31",
                        "2023-12-31",
                        "2023-03-31",
                    ],
                    "acceptanceDateTime": [
                        "2024-05-10T18:00:00Z",
                        "2024-05-01T18:00:00Z",
                        "2024-02-15T18:00:00Z",
                        "2023-05-01T18:00:00Z",
                    ],
                    "form": ["10-Q/A", "10-Q", "10-K", "10-Q"],
                    "primaryDocument": ["qa.htm", "q.htm", "k.htm", "q-old.htm"],
                }
            }
        }

    def _companyfacts(self):
        return {
            "facts": {
                "us-gaap": {
                    "Revenues": _fact(
                        [
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 1000,
                                "accn": self.annual_accession,
                                "form": "10-K",
                                "fy": 2023,
                                "fp": "FY",
                            },
                            {
                                "start": "2023-01-01",
                                "end": "2023-03-31",
                                "val": 250,
                                "accn": self.prior_quarter_accession,
                                "form": "10-Q",
                                "fy": 2023,
                                "fp": "Q1",
                            },
                            {
                                "start": "2024-01-01",
                                "end": "2024-03-31",
                                "val": 300,
                                "accn": self.current_quarter_accession,
                                "form": "10-Q",
                                "fy": 2024,
                                "fp": "Q1",
                            },
                            {
                                "start": "2024-01-01",
                                "end": "2024-03-31",
                                "val": 9999,
                                "accn": self.amendment_accession,
                                "form": "10-Q/A",
                            },
                        ]
                    ),
                    "OperatingIncomeLoss": _fact(
                        [
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 100,
                                "accn": self.annual_accession,
                                "form": "10-K",
                            },
                            {
                                "start": "2023-01-01",
                                "end": "2023-03-31",
                                "val": 25,
                                "accn": self.prior_quarter_accession,
                                "form": "10-Q",
                            },
                            {
                                "start": "2024-01-01",
                                "end": "2024-03-31",
                                "val": 30,
                                "accn": self.current_quarter_accession,
                                "form": "10-Q",
                            },
                        ]
                    ),
                    "Assets": _fact(
                        [
                            {
                                "end": "2023-12-31",
                                "val": 900,
                                "accn": self.annual_accession,
                                "form": "10-K",
                            },
                            {
                                "end": "2023-03-31",
                                "val": 800,
                                "accn": self.prior_quarter_accession,
                                "form": "10-Q",
                            },
                            {
                                "end": "2024-03-31",
                                "val": 950,
                                "accn": self.current_quarter_accession,
                                "form": "10-Q",
                            },
                        ]
                    ),
                }
            }
        }

    def test_quarterly_mode_is_opt_in_and_amendments_stay_excluded(self):
        annual = build_filing_index(self._submissions())
        quarterly = build_filing_index(
            self._submissions(), include_quarterly=True
        )

        self.assertEqual(set(annual), {self.annual_accession})
        self.assertEqual(
            set(quarterly),
            {
                self.annual_accession,
                self.prior_quarter_accession,
                self.current_quarter_accession,
            },
        )
        self.assertEqual(
            quarterly[self.current_quarter_accession]["acceptedAt"],
            datetime(2024, 5, 1, 18, 0),
        )

    def test_quarterly_ttm_uses_only_previously_accepted_original_accessions(self):
        index = build_filing_index(self._submissions(), include_quarterly=True)
        vintages = extract_filing_vintages(
            self._companyfacts(), index, include_quarterly=True
        )
        current = next(
            item
            for item in vintages
            if item["accessionNumber"] == self.current_quarter_accession
        )

        self.assertEqual(current["reportedMetrics"]["revenue"], 300)
        self.assertEqual(current["metrics"]["revenue"], 1050)
        self.assertEqual(current["metrics"]["operating_income"], 105)
        self.assertEqual(current["metrics"]["assets"], 950)
        self.assertEqual(
            current["ttm"]["annualBaseAccession"], self.annual_accession
        )
        self.assertEqual(
            current["ttm"]["comparableQuarterAccession"],
            self.prior_quarter_accession,
        )
        self.assertFalse(current["ttm"]["usesFutureFiling"])
        self.assertEqual(current["unitAudit"]["status"], "ok")
        self.assertEqual(current["unitAudit"]["currency"], "USD")


class RelativeTargetTests(unittest.TestCase):
    def _vintage(self):
        return {
            "accessionNumber": "0000000001-24-000001",
            "form": "10-K",
            "filingFrequency": "annual",
            "acceptedAt": datetime(2024, 1, 1, 18, 0),
            "acceptedAtIso": "2024-01-01T18:00:00Z",
            "reportDate": "2023-12-31",
            "acceptanceFallback": False,
            "metricCoverage": 0.8,
            "missingMetrics": [],
            "missingMetricCount": 0,
            "unitAudit": {"status": "ok", "currency": "USD"},
            "ttm": {"coverage": 0.8},
            "metrics": {
                "revenue": 1000,
                "gross_profit": 500,
                "operating_income": 200,
                "net_income": 150,
                "operating_cash_flow": 180,
                "capital_expenditure": -40,
                "assets": 2000,
                "equity": 1000,
                "current_assets": 700,
                "current_liabilities": 350,
                "cash": 200,
                "receivables": 150,
                "shares_outstanding": 10,
            },
        }

    def test_raw_target_is_preserved_when_market_relative_is_selected(self):
        dates = pd.bdate_range("2024-01-02", periods=320)
        stock = pd.DataFrame(
            {
                "Close": np.linspace(100, 160, len(dates)),
                "Adj Close": np.linspace(100, 160, len(dates)),
                "Stock Splits": np.zeros(len(dates)),
            },
            index=dates,
        )
        market = pd.DataFrame(
            {
                "Close": np.linspace(100, 120, len(dates)),
                "Adj Close": np.linspace(100, 120, len(dates)),
            },
            index=dates,
        )

        rows = build_monthly_samples(
            "TEST",
            [self._vintage()],
            stock,
            benchmark_prices={"market": market},
            benchmark_symbols={"market": "SPY"},
            target_kind="market-relative",
        )
        first = rows[0]

        self.assertIsNotNone(first["target_raw_1m"])
        self.assertAlmostEqual(
            first["target_1m"],
            first["target_raw_1m"] - first["benchmark_return_market_1m"],
        )
        self.assertEqual(first["target_kind"], "market-relative")
        self.assertEqual(first["target_benchmark"], "SPY")
        self.assertTrue(first["target_uses_adjusted_close"])
        self.assertIn("feature_missing_fields", first)
        self.assertEqual(first["unit_audit_status"], "ok")

    def test_relative_target_without_required_benchmark_fails_clearly(self):
        dates = pd.bdate_range("2024-01-02", periods=40)
        prices = pd.DataFrame(
            {"Close": np.arange(40) + 100, "Adj Close": np.arange(40) + 100},
            index=dates,
        )
        with self.assertRaisesRegex(ValueError, "benchmark_prices\\['market'\\]"):
            build_monthly_samples(
                "TEST",
                [self._vintage()],
                prices,
                target_kind="market-relative",
            )


class TrainingInterfaceAuditTests(unittest.TestCase):
    def test_cli_defaults_are_backward_compatible_and_v4_flags_are_explicit(self):
        parser = build_parser()
        defaults = parser.parse_args([])
        selected = parser.parse_args(
            [
                "--filing-frequency",
                "quarterly",
                "--target-kind",
                "market-relative",
                "--market-benchmark",
                "SPY",
            ]
        )

        self.assertEqual(defaults.filing_frequency, "annual")
        self.assertEqual(defaults.target_kind, "raw")
        self.assertFalse(defaults.offline)
        self.assertEqual(defaults.tree_loss_profile, "squared_error")
        self.assertIsNone(defaults.quantile_alpha)
        self.assertEqual(defaults.early_stopping_rounds, 40)
        self.assertIsNone(defaults.security_master)
        self.assertEqual(selected.filing_frequency, "quarterly")
        self.assertEqual(selected.target_kind, "market-relative")
        self.assertEqual(selected.market_benchmark, "SPY")

    def test_tree_training_flags_build_backend_configs_for_both_boosters(self):
        parser = build_parser()
        defaults = _build_model_configs(parser.parse_args([]))
        quantile = _build_model_configs(
            parser.parse_args(
                [
                    "--tree-loss-profile",
                    "quantile",
                    "--quantile-alpha",
                    "0.25",
                    "--tree-rounds",
                    "180",
                    "--early-stopping-rounds",
                    "25",
                ]
            )
        )

        expected_default = {
            "robust_profile": "squared_error",
            "early_stopping_rounds": 40,
            "num_boost_round": 240,
        }
        self.assertEqual(defaults["xgboost"], expected_default)
        self.assertEqual(defaults["lightgbm"], expected_default)
        for algorithm in ("xgboost", "lightgbm"):
            self.assertEqual(quantile[algorithm]["robust_profile"], "quantile")
            self.assertEqual(quantile[algorithm]["quantile_alpha"], 0.25)
            self.assertEqual(quantile[algorithm]["num_boost_round"], 180)
            self.assertEqual(quantile[algorithm]["early_stopping_rounds"], 25)

    def test_quantile_alpha_is_rejected_for_other_profiles_and_outside_range(self):
        parser = build_parser()
        with self.assertRaisesRegex(ValueError, "valido soltanto"):
            _build_model_configs(
                parser.parse_args(
                    [
                        "--tree-loss-profile",
                        "huber",
                        "--quantile-alpha",
                        "0.25",
                    ]
                )
            )
        for invalid in ("0", "1", "-0.1", "1.1"):
            with self.subTest(alpha=invalid), self.assertRaisesRegex(
                ValueError, "strettamente compreso"
            ):
                _build_model_configs(
                    parser.parse_args(
                        [
                            "--tree-loss-profile",
                            "quantile",
                            "--quantile-alpha",
                            invalid,
                        ]
                    )
                )

    def test_early_stopping_zero_disables_and_negative_is_rejected(self):
        parser = build_parser()
        disabled = _build_model_configs(
            parser.parse_args(["--early-stopping-rounds", "0"])
        )
        self.assertEqual(disabled["xgboost"]["early_stopping_rounds"], 0)
        with self.assertRaisesRegex(ValueError, "non puo essere negativo"):
            _build_model_configs(
                parser.parse_args(["--early-stopping-rounds", "-1"])
            )

    def test_security_master_filters_snapshot_membership_and_audits_delisting(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "security-master.json"
            path.write_text(
                json.dumps(
                    {
                        "securities": [
                            {
                                "ticker": "OLD",
                                "valid_from": "2020-01-01",
                                "delist_date": "2021-06-30",
                                "security_type": "common_stock",
                                "sector": "Industrials",
                                "cik": 1,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            lookup, audit = _load_security_master(str(path))
            filtered, excluded = _apply_security_master(
                [
                    {"ticker": "OLD", "snapshot_date": "2021-06-30"},
                    {"ticker": "OLD", "snapshot_date": "2021-07-31"},
                ],
                lookup["OLD"],
            )

        self.assertTrue(audit["historicalMembershipVerified"])
        self.assertEqual(audit["recordsWithDelistDate"], 1)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(excluded, 1)
        self.assertEqual(filtered[0]["security_sector"], "Industrials")
        self.assertTrue(filtered[0]["security_master_verified"])

    def test_missing_security_master_path_fails_instead_of_inventing_membership(self):
        with self.assertRaisesRegex(FileNotFoundError, "Security master non trovato"):
            _load_security_master("does-not-exist/security-master.csv")

    def test_offline_mode_fails_on_cache_miss_without_attempting_network(self):
        with TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.json"
            with self.assertRaisesRegex(FileNotFoundError, "modalita offline"):
                _download_json(
                    "https://example.invalid/never-called",
                    missing,
                    refresh=False,
                    offline=True,
                )


if __name__ == "__main__":
    unittest.main()
