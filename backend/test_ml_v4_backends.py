import copy
import importlib.util
import unittest
from unittest.mock import patch

import numpy as np

from ml.model_backends import (
    backend_capabilities,
    ensemble_seed,
    fit_tree_model,
    predict_tree_model,
    resolve_training_profile,
    tree_contributions,
)


class BackendV4ConfigurationTests(unittest.TestCase):
    def test_capability_audit_is_explicit_about_ranking_contract(self):
        audit = backend_capabilities("xgboost")

        self.assertEqual(
            audit["robustProfiles"],
            ["huber", "quantile", "squared_error"],
        )
        self.assertTrue(audit["temporalValidation"])
        self.assertTrue(audit["earlyStopping"])
        self.assertTrue(audit["ranking"]["librarySupported"])
        self.assertFalse(audit["ranking"]["fitInterfaceSupported"])
        self.assertIn("gruppi", audit["ranking"]["reason"])

    def test_profiles_are_resolved_to_native_objectives(self):
        xgb_huber = resolve_training_profile("xgboost", "pseudohuber")
        lgb_huber = resolve_training_profile("lightgbm", "huber")
        xgb_quantile = resolve_training_profile(
            "xgboost",
            "quantile",
            quantile_alpha=0.25,
        )
        lgb_quantile = resolve_training_profile(
            "lightgbm",
            "quantile",
            quantile_alpha=0.75,
        )

        self.assertEqual(xgb_huber["objective"], "reg:pseudohubererror")
        self.assertEqual(lgb_huber["objective"], "huber")
        self.assertEqual(xgb_quantile["quantile_alpha"], 0.25)
        self.assertEqual(lgb_quantile["alpha"], 0.75)

    def test_quantile_alpha_and_profile_are_validated(self):
        with self.assertRaisesRegex(ValueError, "compreso tra 0 e 1"):
            resolve_training_profile(
                "xgboost",
                "quantile",
                quantile_alpha=1.0,
            )
        with self.assertRaisesRegex(ValueError, "Profilo robusto"):
            resolve_training_profile("lightgbm", "not-a-loss")

    def test_ensemble_seed_is_stable_and_member_zero_is_legacy_seed(self):
        self.assertEqual(ensemble_seed(42, 0), 42)
        self.assertEqual(ensemble_seed(42, 3), ensemble_seed(42, 3))
        self.assertNotEqual(ensemble_seed(42, 1), ensemble_seed(42, 2))
        with self.assertRaisesRegex(ValueError, "maggiore o uguale a zero"):
            ensemble_seed(42, -1)

    def test_lightgbm_profile_validation_and_early_stopping_contract(self):
        class FakeDataset:
            def __init__(self, data, **kwargs):
                self.data = np.asarray(data)
                self.kwargs = kwargs

        class FakeBooster:
            best_iteration = 7

            @staticmethod
            def model_to_string():
                return "fake-lightgbm-model"

        class FakeLightGBM:
            __version__ = "4.6.0-test"
            Dataset = FakeDataset

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
                return FakeBooster()

        fake = FakeLightGBM()
        train_x = np.arange(32, dtype=float).reshape(8, 4)
        train_y = np.linspace(-0.2, 0.3, 8)
        validation_x = np.arange(16, dtype=float).reshape(4, 4)
        validation_y = np.linspace(-0.1, 0.2, 4)

        with patch("ml.model_backends._require_lightgbm", return_value=fake):
            model = fit_tree_model(
                "lightgbm",
                train_x,
                train_y,
                feature_names=["quality", "value"],
                config={"num_boost_round": 25},
                validation_matrix=validation_x,
                validation_target=validation_y,
                robust_profile="quantile",
                quantile_alpha=0.75,
                early_stopping_rounds=4,
                seed=11,
                ensemble_member=1,
            )

        self.assertEqual(fake.train_call["params"]["objective"], "quantile")
        self.assertEqual(fake.train_call["params"]["alpha"], 0.75)
        self.assertEqual(fake.train_call["valid_names"], ["validation"])
        self.assertEqual(
            fake.train_call["callbacks"][0],
            ("early_stopping", 4, False),
        )
        self.assertEqual(model["trainingAudit"]["predictionIterations"], 7)
        self.assertEqual(model["estimator"]["format"], "lightgbm-text")


@unittest.skipUnless(
    importlib.util.find_spec("xgboost") is not None,
    "XGBoost non disponibile nel runtime dei test",
)
class XGBoostV4TrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(7)
        matrix = rng.normal(size=(120, 4))
        target = (
            0.45 * matrix[:, 0]
            - 0.25 * matrix[:, 1]
            + 0.08 * rng.normal(size=matrix.shape[0])
        )
        cls.train_x = matrix[:90]
        cls.train_y = target[:90]
        cls.validation_x = matrix[90:]
        cls.validation_y = target[90:]
        cls.config = {
            "num_boost_round": 60,
            "learning_rate": 0.08,
            "max_depth": 2,
            "min_child_weight": 2,
            "subsample": 0.9,
            "colsample_bytree": 0.9,
        }

    def _fit(self, **kwargs):
        return fit_tree_model(
            "xgboost",
            self.train_x,
            self.train_y,
            feature_names=["quality", "value"],
            config=self.config,
            **kwargs,
        )

    def test_temporal_validation_enables_early_stopping_and_audit(self):
        model = self._fit(
            validation_matrix=self.validation_x,
            validation_target=self.validation_y,
            robust_profile="huber",
            early_stopping_rounds=6,
            seed=19,
            ensemble_member=2,
        )

        audit = model["trainingAudit"]
        self.assertEqual(audit["robustProfile"], "huber")
        self.assertEqual(audit["objective"], "reg:pseudohubererror")
        self.assertTrue(audit["temporalValidation"])
        self.assertTrue(audit["earlyStopping"]["enabled"])
        self.assertEqual(audit["earlyStopping"]["rounds"], 6)
        self.assertEqual(audit["ensembleMember"], 2)
        self.assertEqual(audit["effectiveSeed"], ensemble_seed(19, 2))
        self.assertGreater(audit["predictionIterations"], 0)

        predictions = predict_tree_model(model, self.validation_x)
        contributions = tree_contributions(model, self.validation_x[:3])
        self.assertEqual(predictions.shape, (30,))
        self.assertEqual(contributions.shape, (3, 4))
        self.assertTrue(np.isfinite(predictions).all())

    def test_same_seed_and_member_are_deterministic(self):
        first = self._fit(seed=31, ensemble_member=1)
        second = self._fit(seed=31, ensemble_member=1)

        np.testing.assert_allclose(
            predict_tree_model(first, self.validation_x),
            predict_tree_model(second, self.validation_x),
            rtol=0.0,
            atol=0.0,
        )

    def test_quantile_profile_and_config_control_keys_do_not_reach_library(self):
        config = {
            **self.config,
            "robust_profile": "quantile",
            "quantile_alpha": 0.25,
            "early_stopping_rounds": 5,
        }
        model = fit_tree_model(
            "xgboost",
            self.train_x,
            self.train_y,
            feature_names=["quality", "value"],
            config=config,
            validation_matrix=self.validation_x,
            validation_target=self.validation_y,
        )

        self.assertEqual(
            model["hyperparameters"]["objective"],
            "reg:quantileerror",
        )
        self.assertEqual(model["hyperparameters"]["quantile_alpha"], 0.25)
        self.assertNotIn("robust_profile", model["hyperparameters"])
        self.assertNotIn("early_stopping_rounds", model["hyperparameters"])
        self.assertTrue(
            np.isfinite(predict_tree_model(model, self.validation_x)).all()
        )

    def test_legacy_artifact_without_training_audit_still_predicts(self):
        model = self._fit(seed=42)
        legacy = copy.deepcopy(model)
        legacy.pop("trainingAudit")

        np.testing.assert_allclose(
            predict_tree_model(model, self.validation_x),
            predict_tree_model(legacy, self.validation_x),
        )

    def test_temporal_validation_must_be_complete_and_shape_compatible(self):
        with self.assertRaisesRegex(ValueError, "devono essere passati insieme"):
            self._fit(validation_matrix=self.validation_x)
        with self.assertRaisesRegex(ValueError, "stesso numero di colonne"):
            self._fit(
                validation_matrix=self.validation_x[:, :3],
                validation_target=self.validation_y,
            )


if __name__ == "__main__":
    unittest.main()
