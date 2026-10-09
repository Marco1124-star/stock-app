import copy
import json
import importlib.util
import unittest
from datetime import datetime
from unittest.mock import patch

import numpy as np
import pandas as pd

import app as backend_app
from ml.fundamental_model import (
    DEFAULT_PROMOTION_RULES,
    FEATURE_NAMES,
    _fit_estimator,
    _fit_final_estimator,
    _metrics,
    _select_champion,
    _temporal_validation_block,
    build_feature_vector,
    fit_artifact,
    predict_from_artifact,
)
from ml.point_in_time import (
    build_filing_index,
    build_monthly_samples,
    extract_annual_vintages,
)


def _fact(entries, unit="USD"):
    return {"units": {unit: entries}}


class PointInTimeDatasetTests(unittest.TestCase):
    def setUp(self):
        self.original_accession = "0000000001-24-000001"
        self.amended_accession = "0000000001-25-000002"
        self.submissions = {
            "filings": {
                "recent": {
                    "accessionNumber": [
                        self.amended_accession,
                        self.original_accession,
                    ],
                    "filingDate": ["2025-04-01", "2024-02-15"],
                    "reportDate": ["2023-12-31", "2023-12-31"],
                    "acceptanceDateTime": [
                        "2025-04-01T18:00:00.000Z",
                        "2024-02-15T18:00:00.000Z",
                    ],
                    "form": ["10-K/A", "10-K"],
                    "primaryDocument": ["amend.htm", "original.htm"],
                }
            }
        }

    def test_filing_index_excludes_amendments_and_keeps_acceptance_time(self):
        index = build_filing_index(self.submissions)

        self.assertEqual(list(index), [self.original_accession])
        self.assertEqual(
            index[self.original_accession]["acceptedAt"],
            datetime(2024, 2, 15, 18, 0),
        )
        self.assertFalse(index[self.original_accession]["acceptanceFallback"])

    def test_companyfacts_uses_only_values_from_exact_accession(self):
        facts = {
            "facts": {
                "us-gaap": {
                    "Revenues": _fact(
                        [
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 100,
                                "accn": self.original_accession,
                                "form": "10-K",
                            },
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 999,
                                "accn": self.amended_accession,
                                "form": "10-K/A",
                            },
                        ]
                    ),
                    "Assets": _fact(
                        [
                            {
                                "end": "2023-12-31",
                                "val": 250,
                                "accn": self.original_accession,
                                "form": "10-K",
                            }
                        ]
                    ),
                }
            }
        }

        vintages = extract_annual_vintages(
            facts,
            build_filing_index(self.submissions),
        )

        self.assertEqual(len(vintages), 1)
        self.assertEqual(vintages[0]["metrics"]["revenue"], 100)
        self.assertEqual(vintages[0]["metrics"]["assets"], 250)

    def test_monthly_target_uses_adjusted_close(self):
        dates = pd.bdate_range("2024-02-16", periods=280)
        raw_close = np.concatenate(
            [np.linspace(100, 120, 140), np.linspace(60, 75, 140)]
        )
        adjusted_close = np.linspace(50, 75, 280)
        prices = pd.DataFrame(
            {
                "Close": raw_close,
                "Adj Close": adjusted_close,
            },
            index=dates,
        )
        vintages = [
            {
                "accessionNumber": self.original_accession,
                "acceptedAt": datetime(2024, 2, 15, 18, 0),
                "acceptedAtIso": "2024-02-15T18:00:00Z",
                "reportDate": "2023-12-31",
                "metrics": {
                    "revenue": 100,
                    "assets": 250,
                    "equity": 120,
                    "operating_income": 20,
                    "net_income": 15,
                    "operating_cash_flow": 18,
                    "capital_expenditure": -5,
                    "current_assets": 70,
                    "current_liabilities": 35,
                    "cash": 20,
                    "receivables": 15,
                    "shares_outstanding": 10,
                },
            }
        ]

        samples = build_monthly_samples("TEST", vintages, prices)
        self.assertTrue(samples)
        first = samples[0]
        position = max(
            index
            for index, value in enumerate(dates)
            if value.strftime("%Y-%m") == first["snapshot_date"][:7]
        )
        expected = adjusted_close[position + 21] / adjusted_close[position] - 1
        self.assertAlmostEqual(first["target_1m"], expected)

    def test_filing_published_on_close_date_is_used_from_next_close(self):
        dates = pd.bdate_range("2024-01-02", "2024-04-30")
        prices = pd.DataFrame(
            {
                "Close": np.linspace(100, 110, len(dates)),
                "Adj Close": np.linspace(100, 110, len(dates)),
            },
            index=dates,
        )
        base_metrics = {
            "revenue": 100,
            "gross_profit": 50,
            "operating_income": 20,
            "net_income": 15,
            "operating_cash_flow": 18,
            "capital_expenditure": -5,
            "assets": 250,
            "equity": 120,
            "current_assets": 70,
            "current_liabilities": 35,
            "cash": 20,
            "receivables": 15,
            "shares_outstanding": 10,
        }
        vintages = [
            {
                "accessionNumber": "old",
                "acceptedAt": datetime(2023, 12, 1, 18, 0),
                "acceptedAtIso": "2023-12-01T18:00:00Z",
                "reportDate": "2022-12-31",
                "metrics": base_metrics,
            },
            {
                "accessionNumber": "new",
                "acceptedAt": datetime(2024, 2, 29, 22, 0),
                "acceptedAtIso": "2024-02-29T22:00:00Z",
                "reportDate": "2023-12-31",
                "metrics": {**base_metrics, "revenue": 120},
            },
        ]

        samples = build_monthly_samples("TEST", vintages, prices)
        by_month = {
            row["snapshot_date"][:7]: row["accession_number"]
            for row in samples
        }

        self.assertEqual(by_month["2024-02"], "old")
        self.assertEqual(by_month["2024-03"], "new")


class FundamentalModelTests(unittest.TestCase):
    def test_temporal_validation_tail_is_strictly_after_purged_training(self):
        items = []
        for month_index in range(72):
            snapshot = pd.Timestamp("2018-01-31") + pd.DateOffset(
                months=month_index
            )
            label_date = snapshot + pd.Timedelta(days=100)
            for issuer in range(4):
                row = {
                    "ticker": f"V{issuer}",
                    "snapshot_date": snapshot.date().isoformat(),
                }
                items.append(
                    (
                        row,
                        snapshot.to_pydatetime(),
                        label_date.to_pydatetime(),
                        0.01 * issuer,
                    )
                )

        split = _temporal_validation_block(
            items,
            minimum_training_rows=80,
            minimum_validation_rows=16,
        )

        self.assertIsNotNone(split)
        audit = split["audit"]
        self.assertTrue(audit["strictlySubsequent"])
        self.assertFalse(audit["holdoutUsed"])
        validation_start = pd.Timestamp(audit["validationSnapshotStart"])
        self.assertLess(
            pd.Timestamp(audit["trainingSnapshotEnd"]),
            validation_start,
        )
        self.assertLess(
            pd.Timestamp(audit["latestTrainingLabelDate"]),
            validation_start - pd.Timedelta(days=7),
        )

    @patch("ml.fundamental_model.fit_tree_model")
    def test_tree_estimator_passes_validation_matrix_and_robust_profile(
        self,
        fit_tree,
    ):
        fit_tree.return_value = {
            "modelType": "xgboost",
            "modelDisplayName": "XGBoost",
            "trainingAudit": {"predictionIterations": 7},
            "estimator": {"format": "test", "payload": "test"},
        }
        training_rows = []
        validation_rows = []
        for index in range(20):
            row = {name: None for name in FEATURE_NAMES}
            row.update(
                {
                    "ticker": f"T{index % 4}",
                    "gross_margin": 0.2 + index * 0.001,
                }
            )
            training_rows.append(row)
        for index in range(8):
            row = {name: None for name in FEATURE_NAMES}
            row.update(
                {
                    "ticker": f"V{index % 4}",
                    "gross_margin": 0.3 + index * 0.001,
                }
            )
            validation_rows.append(row)

        model = _fit_estimator(
            "xgboost",
            training_rows,
            np.linspace(-0.02, 0.03, len(training_rows)),
            alpha=2,
            feature_names=FEATURE_NAMES,
            model_configs={
                "xgboost": {
                    "robust_profile": "quantile",
                    "quantile_alpha": 0.75,
                    "early_stopping_rounds": 12,
                }
            },
            seed=17,
            validation_rows=validation_rows,
            validation_target=np.linspace(-0.01, 0.02, len(validation_rows)),
            temporal_audit={"strictlySubsequent": True},
        )

        kwargs = fit_tree.call_args.kwargs
        self.assertEqual(kwargs["validation_matrix"].shape[0], 8)
        self.assertEqual(kwargs["validation_matrix"].shape[1], 62)
        self.assertEqual(kwargs["validation_target"].shape, (8,))
        self.assertEqual(kwargs["validation_weight"].shape, (8,))
        self.assertEqual(kwargs["robust_profile"], "quantile")
        self.assertEqual(kwargs["quantile_alpha"], 0.75)
        self.assertEqual(kwargs["early_stopping_rounds"], 12)
        self.assertTrue(
            model["trainingAudit"]["temporalSplit"]["strictlySubsequent"]
        )

    @patch("ml.fundamental_model._fit_estimator")
    def test_final_refit_selects_rounds_only_from_development_tail(
        self,
        fit_estimator,
    ):
        fit_estimator.side_effect = [
            {
                "modelType": "xgboost",
                "trainingAudit": {
                    "predictionIterations": 9,
                    "temporalValidation": True,
                },
            },
            {
                "modelType": "xgboost",
                "trainingAudit": {"temporalValidation": False},
            },
        ]
        rows = []
        for month_index in range(96):
            snapshot = pd.Timestamp("2016-01-31") + pd.DateOffset(
                months=month_index
            )
            row = {
                "ticker": f"R{month_index % 5}",
                "snapshot_date": snapshot.date().isoformat(),
                "target_1m": 0.01,
                "label_date_1m": (
                    snapshot + pd.Timedelta(days=35)
                ).date().isoformat(),
            }
            rows.append(row)

        model = _fit_final_estimator(
            "xgboost",
            rows,
            horizon="1m",
            development_cutoff=datetime(2023, 1, 1),
            alpha=2,
            feature_names=FEATURE_NAMES,
            minimum_training_rows=30,
            minimum_validation_rows=5,
            model_configs={"xgboost": {"robust_profile": "huber"}},
            seed=19,
        )

        tuning_call = fit_estimator.call_args_list[0]
        final_call = fit_estimator.call_args_list[1]
        tuning_validation = tuning_call.kwargs["validation_rows"]
        self.assertTrue(tuning_validation)
        self.assertTrue(
            all(
                pd.Timestamp(row["snapshot_date"]) < pd.Timestamp("2023-01-01")
                for row in tuning_validation
            )
        )
        self.assertIsNone(final_call.kwargs.get("validation_rows"))
        self.assertEqual(len(final_call.args[1]), len(rows))
        audit = model["trainingAudit"]
        self.assertTrue(audit["roundSelection"]["holdoutExcluded"])
        self.assertEqual(audit["roundSelection"]["selectedIterations"], 9)
        self.assertEqual(audit["finalRefit"]["rows"], len(rows))
        self.assertFalse(audit["finalRefit"]["validationUsed"])

    def test_v4_metrics_are_cross_sectional_and_bootstrap_is_deterministic(self):
        rows = []
        actual = []
        predicted = []
        for month in range(1, 13):
            for issuer in range(4):
                value = -0.03 + issuer * 0.025 + month * 0.0005
                rows.append(
                    {
                        "ticker": f"C{issuer}",
                        "snapshot_date": f"2024-{month:02d}-28",
                        "accession_number": f"filing-C{issuer}",
                    }
                )
                actual.append(value)
                predicted.append(value * 0.9)

        first = _metrics(
            np.asarray(actual),
            np.asarray(predicted),
            rows=rows,
            horizon="3m",
            include_inference=True,
            bootstrap_seed=123,
            bootstrap_iterations=80,
        )
        second = _metrics(
            np.asarray(actual),
            np.asarray(predicted),
            rows=rows,
            horizon="3m",
            include_inference=True,
            bootstrap_seed=123,
            bootstrap_iterations=80,
        )

        self.assertEqual(first["sampleSize"], 48)
        self.assertFalse(first["sampleSizeIsIndependent"])
        self.assertIsNone(first["effectiveSampleSize"])
        self.assertEqual(first["uniqueEvaluationMonths"], 12)
        self.assertEqual(first["uniqueIssuers"], 4)
        self.assertEqual(first["uniqueFilings"], 4)
        self.assertEqual(first["crossSectionalRankIcDateCount"], 12)
        self.assertAlmostEqual(first["crossSectionalRankIcMean"], 1.0)
        self.assertAlmostEqual(first["crossSectionalRankIcMedian"], 1.0)
        self.assertAlmostEqual(first["crossSectionalRankIcPositiveRate"], 1.0)
        self.assertGreater(first["maeEdgeVsZero"], 0)
        self.assertTrue(first["blockBootstrap95"]["available"])
        self.assertEqual(first["blockBootstrap95"], second["blockBootstrap95"])
        robustness = first["nonOverlappingRobustness"]
        self.assertTrue(robustness["available"])
        self.assertEqual(robustness["spacingMonths"], 3)
        self.assertEqual(robustness["phaseCount"], 3)

    def test_feature_formulas_keep_ratios_as_decimals(self):
        current = {
            "revenue": 200,
            "gross_profit": 100,
            "operating_income": 40,
            "net_income": 20,
            "operating_cash_flow": 30,
            "capital_expenditure": -10,
            "assets": 300,
            "equity": 150,
            "current_assets": 100,
            "current_liabilities": 50,
            "cash": 20,
            "receivables": 30,
            "current_debt": 10,
            "long_term_debt": 40,
            "interest_expense": -5,
            "depreciation": 10,
            "shares_outstanding": 10,
        }
        previous = {
            "revenue": 160,
            "net_income": 16,
            "operating_cash_flow": 24,
            "assets": 260,
            "equity": 130,
            "shares_outstanding": 10,
        }

        features = build_feature_vector(
            current,
            previous,
            raw_price=20,
            filing_age_days=90,
        )

        self.assertAlmostEqual(features["revenue_growth_yoy"], 0.25)
        self.assertAlmostEqual(features["gross_margin"], 0.5)
        self.assertAlmostEqual(features["current_ratio"], 2)
        self.assertAlmostEqual(features["quick_ratio"], 1)
        self.assertAlmostEqual(features["debt_to_equity"], 1 / 3)
        self.assertAlmostEqual(features["interest_coverage"], 8)
        self.assertAlmostEqual(features["book_to_market"], 0.75)

    def test_rank_ic_tradeoff_requires_material_stable_improvements(self):
        def candidate(mae, r2, rank_ic, yearly_mae):
            return {
                "performance": {
                    "mae": mae,
                    "baselineZeroMae": 0.11,
                    "oosR2VsZero": r2,
                    "rankIc": rank_ic,
                },
                "folds": [
                    {
                        "testYear": 2018 + index,
                        "performance": {"mae": value},
                    }
                    for index, value in enumerate(yearly_mae)
                ],
            }

        candidates = {
            "ridge": candidate(
                0.10,
                0.01,
                0.05,
                [0.10, 0.10, 0.10, 0.10, 0.10, 0.10],
            ),
            "xgboost": candidate(
                0.097,
                0.04,
                0.044,
                [0.09, 0.09, 0.09, 0.09, 0.09, 0.11],
            ),
            "lightgbm": candidate(
                0.096,
                0.04,
                0.039,
                [0.09, 0.09, 0.09, 0.09, 0.09, 0.11],
            ),
            "weakboost": candidate(
                0.099,
                0.02,
                0.044,
                [0.09, 0.09, 0.09, 0.09, 0.09, 0.11],
            ),
        }

        champion, selection = _select_champion(
            candidates,
            promotion_rules=DEFAULT_PROMOTION_RULES,
        )

        self.assertEqual(champion, "xgboost")
        self.assertTrue(
            selection["candidateAudit"]["xgboost"][
                "rankIcTradeoffApplied"
            ]
        )
        self.assertTrue(
            selection["candidateAudit"]["xgboost"]["checks"][
                "preservesRankIc"
            ]
        )
        self.assertFalse(
            selection["candidateAudit"]["lightgbm"][
                "rankIcTradeoffApplied"
            ]
        )
        self.assertFalse(
            selection["candidateAudit"]["lightgbm"]["checks"][
                "preservesRankIc"
            ]
        )
        self.assertFalse(
            selection["candidateAudit"]["weakboost"][
                "rankIcTradeoffApplied"
            ]
        )

    def _synthetic_rows(self):
        rows = []
        rng = np.random.default_rng(13)
        for year in range(2014, 2025):
            for month in range(1, 13):
                for issuer in range(5):
                    gross_margin = 0.18 + issuer * 0.08 + rng.normal(0, 0.01)
                    accrual = rng.normal(0, 0.04)
                    coverage = 1.5 + issuer * 1.2
                    features = {name: None for name in FEATURE_NAMES}
                    features.update(
                        {
                            "gross_margin": gross_margin,
                            "accrual_ratio": accrual,
                            "interest_coverage": coverage,
                            "filing_age_years": month / 12,
                        }
                    )
                    base = 0.18 * gross_margin - 0.25 * accrual + 0.002 * coverage
                    snapshot = f"{year}-{month:02d}-15"
                    row = {
                        "ticker": f"T{issuer}",
                        "snapshot_date": snapshot,
                        **features,
                    }
                    for horizon, multiplier, days in (
                        ("1m", 0.35, 35),
                        ("3m", 0.75, 100),
                        ("1y", 1.5, 370),
                    ):
                        label = pd.Timestamp(snapshot) + pd.Timedelta(days=days)
                        row[f"target_{horizon}"] = (
                            base * multiplier + rng.normal(0, 0.004)
                        )
                        row[f"label_date_{horizon}"] = label.date().isoformat()
                    rows.append(row)
        return rows

    def test_training_is_temporal_serializable_and_exposes_evidence(self):
        rows = self._synthetic_rows()
        artifact = fit_artifact(
            rows,
            alpha=2,
            minimum_training_rows=100,
            minimum_test_rows=20,
        )

        json.dumps(artifact, allow_nan=False)
        self.assertEqual(set(artifact["models"]), {"1m", "3m", "1y"})
        self.assertEqual(
            artifact["validationVersion"],
            "cross-sectional-block-bootstrap-v4",
        )
        self.assertEqual(artifact["dataset"]["uniqueEvaluationMonths"], 132)
        self.assertFalse(artifact["dataset"]["sampleSizeIsIndependent"])
        for model in artifact["models"].values():
            self.assertGreater(model["performance"]["sampleSize"], 0)
            self.assertGreater(model["performance"]["oosR2VsZero"], 0)
            self.assertGreater(
                model["performance"]["crossSectionalRankIcDateCount"],
                0,
            )
            self.assertIn("maeEdgeVsZero", model["performance"])
            self.assertIn("blockBootstrap95", model["performance"])
            self.assertIn(
                "nonOverlappingRobustness",
                model["performance"],
            )
            self.assertFalse(model["selection"]["holdoutUsedForSelection"])
            self.assertEqual(
                model["selection"]["champion"],
                model["selection"]["developmentChampion"],
            )
            self.assertTrue(model["selection"]["independentHoldout"])
            self.assertEqual(len(model["selection"]["holdoutYears"]), 2)
            self.assertGreater(model["calibrationSampleSize"], 0)
            self.assertEqual(
                model["performance"]["sampleSize"],
                sum(
                    fold["performance"]["sampleSize"]
                    for fold in model["candidatePerformance"]["ridge"][
                        "holdoutFolds"
                    ]
                ),
            )
            for fold in model["folds"]:
                self.assertLess(
                    fold["latestTrainingLabelDate"],
                    f"{fold['testYear']}-01-01",
                )

        features = dict(rows[-1])
        prediction = predict_from_artifact(artifact, features)
        self.assertEqual(len(prediction["predictions"]), 3)
        self.assertEqual(
            set(prediction["driversByHorizon"]),
            set(prediction["predictions"][index]["horizon"] for index in range(3)),
        )
        for item in prediction["predictions"]:
            self.assertIn("maeEdgeVsZeroPct", item["performance"])
            self.assertIn("validationStatus", item["performance"])
            self.assertIn("interval80CalibrationStatus", item["performance"])
        self.assertGreater(
            prediction["dataQuality"]["featureCoveragePct"],
            0,
        )
        self.assertTrue(prediction["drivers"]["strengths"])

    def test_legacy_ridge_artifact_without_model_type_still_predicts(self):
        rows = self._synthetic_rows()
        artifact = fit_artifact(
            rows,
            alpha=2,
            minimum_training_rows=100,
            minimum_test_rows=20,
        )
        for model in artifact["models"].values():
            model.pop("modelType", None)
            model.pop("modelDisplayName", None)

        prediction = predict_from_artifact(artifact, dict(rows[-1]))

        self.assertEqual(len(prediction["predictions"]), 3)
        self.assertTrue(
            all(
                item["modelType"] == "ridge"
                for item in prediction["predictions"]
            )
        )

    @unittest.skipUnless(
        importlib.util.find_spec("xgboost")
        and importlib.util.find_spec("lightgbm"),
        "XGBoost e LightGBM non disponibili",
    )
    def test_challengers_are_compared_and_tree_artifact_round_trips(self):
        rng = np.random.default_rng(37)
        rows = []
        for year in range(2014, 2026):
            for month in range(1, 13):
                for issuer in range(6):
                    quality = rng.uniform(-1, 1)
                    leverage = rng.uniform(-1, 1)
                    nonlinear_signal = (
                        0.08
                        if (quality > 0) != (leverage > 0)
                        else -0.05
                    )
                    features = {name: None for name in FEATURE_NAMES}
                    features.update(
                        {
                            "gross_margin": quality,
                            "debt_to_assets": leverage,
                            "filing_age_years": month / 12,
                        }
                    )
                    snapshot = f"{year}-{month:02d}-15"
                    row = {
                        "ticker": f"N{issuer}",
                        "snapshot_date": snapshot,
                        **features,
                    }
                    for horizon, multiplier, days in (
                        ("1m", 0.5, 35),
                        ("3m", 1.0, 100),
                        ("1y", 1.8, 370),
                    ):
                        label = pd.Timestamp(snapshot) + pd.Timedelta(days=days)
                        row[f"target_{horizon}"] = (
                            nonlinear_signal * multiplier
                            + rng.normal(0, 0.002)
                        )
                        row[f"label_date_{horizon}"] = (
                            label.date().isoformat()
                        )
                    rows.append(row)

        artifact = fit_artifact(
            rows,
            alpha=8,
            algorithms=("ridge", "xgboost", "lightgbm"),
            model_configs={
                "xgboost": {
                    "num_boost_round": 60,
                    "min_child_weight": 5,
                },
                "lightgbm": {
                    "num_boost_round": 60,
                    "min_data_in_leaf": 10,
                },
            },
            minimum_training_rows=100,
            minimum_test_rows=20,
        )

        json.dumps(artifact, allow_nan=False)
        self.assertEqual(artifact["schemaVersion"], 2)
        self.assertEqual(
            set(artifact["dataset"]["algorithmsEvaluated"]),
            {"ridge", "xgboost", "lightgbm"},
        )
        for model in artifact["models"].values():
            self.assertEqual(
                set(model["candidatePerformance"]),
                {"ridge", "xgboost", "lightgbm"},
            )
        self.assertTrue(
            any(
                model["modelType"] in {"xgboost", "lightgbm"}
                for model in artifact["models"].values()
            )
        )

        prediction = predict_from_artifact(artifact, dict(rows[-1]))
        self.assertEqual(len(prediction["predictions"]), 3)
        self.assertTrue(
            all(
                np.isfinite(item["expectedReturnPct"])
                for item in prediction["predictions"]
            )
        )
        self.assertTrue(
            all(item.get("modelDisplayName") for item in prediction["predictions"])
        )

        broken_artifact = copy.deepcopy(artifact)
        broken_horizon = next(
            horizon
            for horizon, model in broken_artifact["models"].items()
            if model.get("fallbackModel")
        )
        broken_model = broken_artifact["models"][broken_horizon]
        broken_model["modelType"] = "lightgbm"
        broken_model["modelDisplayName"] = "LightGBM"
        broken_model["estimator"] = {
            "format": "lightgbm-text",
            "payload": "payload-lightgbm-corrotto",
        }

        fallback_prediction = predict_from_artifact(
            broken_artifact,
            dict(rows[-1]),
        )
        fallback_horizon = next(
            item
            for item in fallback_prediction["predictions"]
            if item["horizon"] == broken_horizon
        )
        self.assertTrue(fallback_horizon["runtimeFallbackUsed"])
        self.assertEqual(fallback_horizon["modelType"], "ridge")

        broken_xgboost_artifact = copy.deepcopy(artifact)
        broken_xgboost_model = broken_xgboost_artifact["models"][
            broken_horizon
        ]
        broken_xgboost_model["modelType"] = "xgboost"
        broken_xgboost_model["modelDisplayName"] = "XGBoost"
        broken_xgboost_model["estimator"] = {
            "format": "xgboost-json-base64",
            "payload": "payload-xgboost-corrotto",
        }
        broken_xgboost_prediction = predict_from_artifact(
            broken_xgboost_artifact,
            dict(rows[-1]),
        )
        broken_xgboost_horizon = next(
            item
            for item in broken_xgboost_prediction["predictions"]
            if item["horizon"] == broken_horizon
        )
        self.assertTrue(broken_xgboost_horizon["runtimeFallbackUsed"])
        self.assertEqual(broken_xgboost_horizon["modelType"], "ridge")

        class NativePredictionFailure:
            def predict(self, _matrix, **_kwargs):
                raise OSError("errore nativo simulato durante predict")

        native_failure_artifact = copy.deepcopy(artifact)
        native_failure_model = native_failure_artifact["models"][broken_horizon]
        native_failure_model["modelType"] = "lightgbm"
        native_failure_model["modelDisplayName"] = "LightGBM"
        native_failure_model["estimator"] = {
            "format": "lightgbm-text",
            "payload": "payload-lightgbm-predict-error",
        }
        with patch(
            "ml.model_backends._load_lightgbm",
            return_value=NativePredictionFailure(),
        ):
            native_failure_prediction = predict_from_artifact(
                native_failure_artifact,
                dict(rows[-1]),
            )
        native_failure_horizon = next(
            item
            for item in native_failure_prediction["predictions"]
            if item["horizon"] == broken_horizon
        )
        self.assertTrue(native_failure_horizon["runtimeFallbackUsed"])
        self.assertEqual(native_failure_horizon["modelType"], "ridge")

        class NativeContributionFailure:
            def predict(self, matrix, **kwargs):
                if kwargs.get("pred_contrib"):
                    raise OSError("errore nativo simulato durante TreeSHAP")
                return np.zeros(matrix.shape[0], dtype=float)

        contribution_failure_artifact = copy.deepcopy(native_failure_artifact)
        contribution_failure_artifact["models"][broken_horizon]["estimator"][
            "payload"
        ] = "payload-lightgbm-contribution-error"
        with patch(
            "ml.model_backends._load_lightgbm",
            return_value=NativeContributionFailure(),
        ):
            contribution_failure_prediction = predict_from_artifact(
                contribution_failure_artifact,
                dict(rows[-1]),
            )
        contribution_failure_horizon = next(
            item
            for item in contribution_failure_prediction["predictions"]
            if item["horizon"] == broken_horizon
        )
        self.assertTrue(contribution_failure_horizon["runtimeFallbackUsed"])
        self.assertEqual(contribution_failure_horizon["modelType"], "ridge")


class FundamentalForecastEndpointTests(unittest.TestCase):
    def setUp(self):
        backend_app.fundamental_forecast_cache.clear()
        self.client = backend_app.app.test_client()

    @patch("app._load_fundamental_model_artifact", return_value=None)
    def test_endpoint_is_explicit_when_artifact_is_missing(self, _artifact):
        response = self.client.get("/stock/AAPL/fundamental-return-forecast")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["status"], "unavailable")

    @patch("app._fetch_quote_fields", return_value={})
    @patch(
        "app._fetch_chart_data",
        return_value=(
            pd.DataFrame({"Close": [100.0]}, index=[pd.Timestamp("2026-07-27")]),
            {"regularMarketPrice": 100.0},
        ),
    )
    @patch(
        "app.predict_from_artifact",
        return_value={
            "status": "ready",
            "predictions": [
                {
                    "horizon": "1m",
                    "publishable": True,
                    "expectedReturnPct": 2.0,
                    "performance": {"interval80CoveragePct": 70.0},
                }
            ],
            "drivers": {"strengths": [], "attentionSignals": []},
            "dataQuality": {
                "featureCoveragePct": 90.0,
                "missingFeatures": [],
            },
        },
    )
    @patch("app.extract_ml_annual_vintages")
    @patch("app.build_ml_filing_index", return_value={"accession": {}})
    @patch(
        "app._fetch_sec_submissions_payload",
        return_value={"cik": "1", "name": "Test Corp", "sic": "3571"},
    )
    @patch("app._fetch_sec_companyfacts_payload", return_value={"cik": 1})
    @patch("app.ticker_candidates", return_value=["TEST"])
    @patch(
        "app._load_fundamental_model_artifact",
        return_value={
            "modelVersion": "test-v1",
            "generatedAt": "2026-07-01T00:00:00Z",
            "modelSummary": {
                "displayName": "XGBoost / LightGBM",
            },
            "featureNames": FEATURE_NAMES,
            "horizons": {"1m": {"label": "1 mese"}},
            "models": {
                "1m": {
                    "trainingEnd": "2025-12-31",
                    "selection": {
                        "rankIcTradeoffApplied": True,
                        "policyValidationStatus": (
                            "prospective-confirmation-required"
                        ),
                    },
                }
            },
            "dataset": {"rows": 1000, "issuers": 50, "knownLimitations": []},
            "methodology": {},
        },
    )
    def test_endpoint_exposes_filing_forecast_and_audit_metadata(
        self,
        _artifact,
        _ticker_candidates,
        _companyfacts,
        _submissions,
        _filing_index,
        extract_vintages,
        _prediction,
        _chart,
        _quote,
    ):
        extract_vintages.return_value = [
            {
                "accessionNumber": "0000000001-26-000001",
                "form": "10-K",
                "acceptedAt": datetime(2026, 2, 15, 18, 0),
                "acceptedAtIso": "2026-02-15T18:00:00Z",
                "reportDate": "2025-12-31",
                "acceptanceFallback": False,
                "metricCoverage": 0.8,
                "metrics": {
                    "revenue": 100.0,
                    "assets": 200.0,
                    "equity": 100.0,
                    "shares_outstanding": 1.0,
                },
            }
        ]

        response = self.client.get("/stock/TEST/fundamental-return-forecast")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["modelVersion"], "test-v1")
        self.assertEqual(
            payload["modelSummary"]["displayName"],
            "XGBoost / LightGBM",
        )
        self.assertEqual(payload["filing"]["form"], "10-K")
        self.assertEqual(payload["predictions"][0]["horizon"], "1m")
        self.assertEqual(payload["dataset"]["rows"], 1000)
        warnings = payload["dataQuality"]["warnings"]
        self.assertTrue(
            any("esplorativa per: 1 mese" in warning for warning in warnings)
        )
        self.assertTrue(
            any("intervallo nominale" in warning for warning in warnings)
        )
        warning_objects = payload["dataQuality"]["warningObjects"]
        self.assertTrue(
            any(
                warning["code"] == "prospective-confirmation"
                for warning in warning_objects
            )
        )
        self.assertTrue(
            any(
                warning["code"] == "interval-undercoverage"
                for warning in warning_objects
            )
        )
        self.assertIn("driversByHorizon", payload)
        self.assertEqual(payload["dataQuality"]["priceAsOf"], "2026-07-27")

    @patch("app._fetch_quote_fields", return_value={})
    @patch(
        "app._fetch_chart_data",
        return_value=(
            pd.DataFrame({"Close": [101.0]}, index=[pd.Timestamp("2026-08-07")]),
            {"regularMarketPrice": 101.0},
        ),
    )
    @patch(
        "app.predict_from_artifact",
        return_value={
            "status": "limited",
            "predictions": [
                {
                    "horizon": "1m",
                    "publishable": False,
                    "validationStatus": "notValidated",
                    "performance": {},
                }
            ],
            "drivers": {"strengths": [], "attentionSignals": []},
            "driversByHorizon": {"1m": {"strengths": [], "attentionSignals": []}},
            "dataQuality": {"featureCoveragePct": 90.0},
        },
    )
    @patch("app.extract_ml_annual_vintages")
    @patch("app.extract_ml_filing_vintages")
    @patch("app.build_ml_filing_index", return_value={"quarterly": {}})
    @patch(
        "app._fetch_sec_submissions_payload",
        return_value={"cik": "1", "name": "Quarterly Corp", "sic": "3571"},
    )
    @patch("app._fetch_sec_companyfacts_payload", return_value={"cik": 1})
    @patch("app.ticker_candidates", return_value=["TEST"])
    @patch(
        "app._load_fundamental_model_artifact",
        return_value={
            "modelVersion": "test-v4",
            "generatedAt": "2026-08-09T00:00:00Z",
            "featureNames": FEATURE_NAMES,
            "models": {"1m": {"trainingEnd": "2025-12-31"}},
            "dataset": {
                "rows": 100,
                "issuers": 10,
                "filingPolicy": {"frequency": "quarterly"},
                "targetPolicy": {"selected": "market-relative", "benchmarks": {"market": "SPY"}},
            },
            "methodology": {"target": "Rendimento del titolo meno SPY"},
        },
    )
    def test_endpoint_aligns_quarterly_artifact_and_relative_target(
        self,
        _artifact,
        _ticker_candidates,
        _companyfacts,
        _submissions,
        filing_index,
        quarterly_vintages,
        annual_vintages,
        _prediction,
        _chart,
        _quote,
    ):
        quarterly_vintages.return_value = [
            {
                "accessionNumber": "0000000001-26-000002",
                "form": "10-Q",
                "filingFrequency": "quarterly",
                "acceptedAt": datetime(2026, 7, 31, 18, 0),
                "acceptedAtIso": "2026-07-31T18:00:00Z",
                "reportDate": "2026-06-30",
                "metricCoverage": 0.9,
                "metrics": {
                    "revenue": 100.0,
                    "assets": 200.0,
                    "equity": 100.0,
                    "shares_outstanding": 1.0,
                },
            }
        ]

        response = self.client.get("/stock/TEST/fundamental-return-forecast")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        filing_index.assert_called_once_with(
            {"cik": "1", "name": "Quarterly Corp", "sic": "3571"},
            include_quarterly=True,
        )
        quarterly_vintages.assert_called_once_with(
            {"cik": 1},
            {"quarterly": {}},
            include_quarterly=True,
        )
        annual_vintages.assert_not_called()
        self.assertEqual(payload["filing"]["frequency"], "quarterly")
        self.assertEqual(payload["dataset"]["targetKind"], "market-relative")
        self.assertEqual(payload["dataset"]["targetBenchmarks"]["market"], "SPY")
        self.assertIn("1m", payload["driversByHorizon"])


if __name__ == "__main__":
    unittest.main()
