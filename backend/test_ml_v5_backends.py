import base64
import unittest
from unittest.mock import patch

import numpy as np

from ml.model_backends import (
    backend_capabilities,
    backend_runtime_availability,
    fit_tree_model,
    predict_tree_model,
    resolve_training_profile,
)


class _FakeXGBoostDMatrix:
    instances = []

    def __init__(self, data, **kwargs):
        self.data = np.asarray(data)
        self.kwargs = kwargs
        self.group = None
        self.__class__.instances.append(self)

    def set_group(self, group):
        self.group = list(group)


class _FakeXGBoostBooster:
    best_iteration = 2

    @staticmethod
    def save_raw(raw_format="json"):
        if raw_format != "json":
            raise AssertionError("Il backend deve usare il formato JSON nativo.")
        return b'{"fake":"xgboost"}'


class _FakeXGBoost:
    __version__ = "3.2.1-test"
    DMatrix = _FakeXGBoostDMatrix

    def __init__(self):
        self.train_call = None

    def train(self, params, training, **kwargs):
        self.train_call = {
            "params": params,
            "training": training,
            **kwargs,
        }
        return _FakeXGBoostBooster()


class _FakeLightGBMDataset:
    instances = []

    def __init__(self, data, **kwargs):
        self.data = np.asarray(data)
        self.kwargs = kwargs
        self.__class__.instances.append(self)


class _FakeLightGBMBooster:
    best_iteration = 5

    @staticmethod
    def model_to_string():
        return "fake-lightgbm-lambdamart"


class _FakeLightGBM:
    __version__ = "4.6.0-test"
    Dataset = _FakeLightGBMDataset

    def __init__(self):
        self.train_call = None

    @staticmethod
    def early_stopping(rounds, verbose=False):
        return ("early_stopping", rounds, verbose)

    @staticmethod
    def log_evaluation(period=1):
        return ("log_evaluation", period)

    def train(self, params, training, **kwargs):
        self.train_call = {
            "params": params,
            "training": training,
            **kwargs,
        }
        return _FakeLightGBMBooster()


class _FakeCatBoostPool:
    instances = []

    def __init__(self, data, **kwargs):
        self.data = np.asarray(data, dtype=object)
        self.kwargs = kwargs
        self.__class__.instances.append(self)


class _FakeCatBoostEstimator:
    instances = []

    def __init__(self, **params):
        self.params = params
        self.fit_call = None
        self.tree_count_ = int(params.get("iterations", 1))
        self.__class__.instances.append(self)

    def fit(self, training, **kwargs):
        self.fit_call = {"training": training, **kwargs}
        return self

    @staticmethod
    def get_best_iteration():
        return 3

    @staticmethod
    def save_model(path, format="cbm"):
        if format != "cbm":
            raise AssertionError("Il backend deve usare il formato CBM nativo.")
        with open(path, "wb") as stream:
            stream.write(b"fake-catboost-cbm")


class _FakeCatBoost:
    __version__ = "1.2.8-test"
    Pool = _FakeCatBoostPool
    CatBoostRegressor = _FakeCatBoostEstimator
    CatBoostClassifier = _FakeCatBoostEstimator
    CatBoostRanker = _FakeCatBoostEstimator


class BackendV5CapabilityTests(unittest.TestCase):
    def test_capabilities_expose_catboost_objectives_and_runtime_fallback(self):
        with patch("ml.model_backends.importlib.util.find_spec", return_value=None):
            audit = backend_capabilities("catboost")
            availability = backend_runtime_availability("catboost")

        self.assertFalse(audit["available"])
        self.assertEqual(availability["fallbackAlgorithm"], "ridge")
        self.assertIn("pip install catboost", availability["installHint"])
        self.assertTrue(audit["nativeCategoricalFeatures"]["supported"])
        self.assertTrue(audit["nativeCategoricalFeatures"]["orderedBoosting"])
        self.assertTrue(audit["objectiveModes"]["classification"]["supported"])
        self.assertTrue(audit["objectiveModes"]["ranking"]["supported"])
        self.assertTrue(audit["ranking"]["v5FitInterfaceSupported"])

    def test_catboost_robust_profiles_are_native_and_inspectable(self):
        huber = resolve_training_profile("catboost", "huber")
        quantile = resolve_training_profile(
            "catboost",
            "quantile",
            quantile_alpha=0.25,
        )

        self.assertEqual(huber["loss_function"], "Huber:delta=1.0")
        self.assertEqual(quantile["loss_function"], "Quantile:alpha=0.25")
        self.assertEqual(quantile["eval_metric"], "Quantile:alpha=0.25")


class BackendV5LambdaMARTRankingTests(unittest.TestCase):
    def setUp(self):
        _FakeXGBoostDMatrix.instances = []
        _FakeLightGBMDataset.instances = []
        self.train_x = np.arange(12, dtype=float).reshape(6, 2)
        self.train_y = np.asarray([0, 2, 1, 1, 0, 2], dtype=float)
        self.train_qid = [
            "2024-01-31",
            "2024-01-31",
            "2024-01-31",
            "2024-02-29",
            "2024-02-29",
            "2024-02-29",
        ]
        self.validation_x = np.arange(8, dtype=float).reshape(4, 2)
        self.validation_y = np.asarray([0, 1, 1, 0], dtype=float)
        self.validation_qid = [
            "2024-03-31",
            "2024-03-31",
            "2024-04-30",
            "2024-04-30",
        ]

    def _ranking_kwargs(self):
        return {
            "feature_names": ["quality", "momentum"],
            "objective_mode": "ranking",
            "query_ids": self.train_qid,
            "validation_matrix": self.validation_x,
            "validation_target": self.validation_y,
            "validation_query_ids": self.validation_qid,
            "early_stopping_rounds": 4,
            "sample_weight": np.asarray([1, 2, 3, 4, 5, 6], dtype=float),
            "validation_weight": np.ones(4),
            "config": {"num_boost_round": 20},
        }

    def test_xgboost_uses_lambdamart_group_weights_and_temporal_validation(self):
        fake = _FakeXGBoost()
        with patch("ml.model_backends._require_xgboost", return_value=fake):
            model = fit_tree_model(
                "xgboost",
                self.train_x,
                self.train_y,
                **self._ranking_kwargs(),
            )

        training, validation = _FakeXGBoostDMatrix.instances
        self.assertEqual(fake.train_call["params"]["objective"], "rank:ndcg")
        self.assertEqual(training.group, [3, 3])
        self.assertEqual(validation.group, [2, 2])
        np.testing.assert_allclose(training.kwargs["weight"], [2.0, 5.0])
        self.assertEqual(model["predictionKind"], "rankingScore")
        self.assertTrue(
            model["trainingAudit"]["queryGrouping"]["temporalOrderVerified"]
        )
        self.assertFalse(model["trainingAudit"]["queryGrouping"]["rowsReordered"])

    def test_lightgbm_uses_lambdarank_and_query_group_sizes(self):
        fake = _FakeLightGBM()
        with patch("ml.model_backends._require_lightgbm", return_value=fake):
            model = fit_tree_model(
                "lightgbm",
                self.train_x,
                self.train_y,
                **self._ranking_kwargs(),
            )

        training, validation = _FakeLightGBMDataset.instances
        self.assertEqual(fake.train_call["params"]["objective"], "lambdarank")
        self.assertEqual(training.kwargs["group"], [3, 3])
        self.assertEqual(validation.kwargs["group"], [2, 2])
        self.assertEqual(model["trainingAudit"]["objectiveMode"], "ranking")
        self.assertEqual(model["trainingAudit"]["predictionIterations"], 5)

    def test_ranking_rejects_nonordinal_or_noncontiguous_or_leaking_queries(self):
        base = {
            "feature_names": ["quality", "momentum"],
            "objective_mode": "ranking",
        }
        with self.assertRaisesRegex(ValueError, "intere non negative"):
            fit_tree_model(
                "xgboost",
                self.train_x,
                np.linspace(-0.1, 0.2, 6),
                query_groups=[3, 3],
                **base,
            )
        with self.assertRaisesRegex(ValueError, "ricomparire"):
            fit_tree_model(
                "xgboost",
                self.train_x,
                self.train_y,
                query_ids=["a", "a", "b", "b", "a", "a"],
                **base,
            )
        with self.assertRaisesRegex(ValueError, "successive"):
            fit_tree_model(
                "xgboost",
                self.train_x,
                self.train_y,
                query_ids=self.train_qid,
                validation_matrix=self.validation_x,
                validation_target=self.validation_y,
                validation_query_ids=[
                    "2023-11-30",
                    "2023-11-30",
                    "2023-12-31",
                    "2023-12-31",
                ],
                **base,
            )


class BackendV5CatBoostTests(unittest.TestCase):
    def setUp(self):
        _FakeCatBoostPool.instances = []
        _FakeCatBoostEstimator.instances = []

    def test_ordered_catboost_preserves_native_categories_and_serializes_cbm(self):
        matrix = np.asarray(
            [
                [0.5, 0.0, "Technology"],
                [0.2, 1.0, None],
                [0.8, 0.0, "Health Care"],
                [0.1, 1.0, np.nan],
            ],
            dtype=object,
        )
        validation = matrix[:2].copy()
        with patch("ml.model_backends._require_catboost", return_value=_FakeCatBoost):
            model = fit_tree_model(
                "catboost",
                matrix,
                np.asarray([0.1, -0.2, 0.3, -0.1]),
                feature_names=["quality", "quality__missing", "sector"],
                categorical_feature_indices=[2],
                robust_profile="huber",
                validation_matrix=validation,
                validation_target=np.asarray([0.05, -0.1]),
                early_stopping_rounds=3,
                config={"num_boost_round": 12},
                seed=17,
            )

        training_pool = _FakeCatBoostPool.instances[0]
        estimator = _FakeCatBoostEstimator.instances[0]
        self.assertEqual(training_pool.data[1, 2], "__MISSING__")
        self.assertEqual(training_pool.data[3, 2], "__MISSING__")
        self.assertEqual(training_pool.kwargs["cat_features"], [2])
        self.assertEqual(estimator.params["boosting_type"], "Ordered")
        self.assertEqual(estimator.params["loss_function"], "Huber:delta=1.0")
        self.assertEqual(model["expandedFeatureNames"][-1], "sector")
        self.assertEqual(model["estimator"]["format"], "catboost-cbm-base64")
        self.assertEqual(
            base64.b64decode(model["estimator"]["payload"]),
            b"fake-catboost-cbm",
        )
        self.assertTrue(
            model["trainingAudit"]["categoricalFeatures"]["orderedBoosting"]
        )

    def test_catboost_binary_classification_emits_probability_contract(self):
        with patch("ml.model_backends._require_catboost", return_value=_FakeCatBoost):
            model = fit_tree_model(
                "catboost",
                np.arange(12, dtype=float).reshape(6, 2),
                np.asarray([0, 1, 0, 1, 0, 1]),
                feature_names=["quality", "momentum"],
                objective_mode="classification",
                config={"num_boost_round": 8},
            )

        estimator = _FakeCatBoostEstimator.instances[0]
        self.assertEqual(estimator.params["loss_function"], "Logloss")
        self.assertEqual(model["predictionKind"], "positiveClassProbability")
        self.assertEqual(model["trainingAudit"]["objectiveMode"], "classification")

    def test_catboost_probability_prediction_is_one_dimensional(self):
        class ProbabilityBooster:
            @staticmethod
            def predict(data, prediction_type=None, **kwargs):
                if prediction_type != "Probability":
                    raise AssertionError("Attesa inferenza probabilistica.")
                return np.asarray([[0.2, 0.8], [0.7, 0.3]])

        model = {
            "modelType": "catboost",
            "objectiveMode": "classification",
            "predictionKind": "positiveClassProbability",
            "expandedFeatureNames": ["quality", "sector"],
            "categoricalFeatureIndices": [1],
            "trainingAudit": {"predictionIterations": 4},
            "estimator": {
                "format": "catboost-cbm-base64",
                "payload": "unused-in-mocked-runtime",
            },
        }
        matrix = np.asarray([[0.2, "Technology"], [0.4, None]], dtype=object)
        with (
            patch(
                "ml.model_backends._tree_runtime",
                return_value=("catboost", ProbabilityBooster()),
            ),
            patch("ml.model_backends._require_catboost", return_value=_FakeCatBoost),
        ):
            predictions = predict_tree_model(model, matrix)

        np.testing.assert_allclose(predictions, [0.8, 0.3])
        self.assertEqual(predictions.shape, (2,))

    def test_native_categories_are_rejected_for_non_catboost_backends(self):
        with self.assertRaisesRegex(ValueError, "solo per CatBoost"):
            fit_tree_model(
                "lightgbm",
                np.arange(8, dtype=float).reshape(4, 2),
                np.asarray([0.1, 0.2, -0.1, 0.0]),
                feature_names=["quality", "sector"],
                categorical_feature_indices=[1],
            )


if __name__ == "__main__":
    unittest.main()
