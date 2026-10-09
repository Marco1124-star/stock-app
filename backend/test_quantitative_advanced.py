import numpy as np
import unittest

from ml.quantitative_advanced import (
    _garch11,
    _load_training_dataset,
    _load_security_master,
    _regularized_models,
    build_quantitative_research_payload,
)


class QuantitativeAdvancedTests(unittest.TestCase):
    def test_point_in_time_dataset_and_regularized_models_are_available(self):
        frame = _load_training_dataset()
        self.assertGreater(len(frame), 1000)
        result = _regularized_models(frame, "3m")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(set(result["models"]), {"ridge", "lasso", "elasticnet"})
        self.assertEqual(result["validation"], "80/20 temporal, no random shuffle")


    def test_garch_has_finite_parameters_or_explicit_unavailable_status(self):
        returns = np.sin(np.arange(160) * 0.17) * 0.01
        result = _garch11(returns)
        self.assertEqual(result["status"], "ready")
        self.assertTrue(np.isfinite(result["conditionalVolatility"]))
        self.assertTrue(0 <= result["persistence"] < 1)


    def test_research_payload_declares_security_master_and_model_governance(self):
        result = build_quantitative_research_payload({}, "AAPL", returns=np.zeros(120))
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["universe"]["pointInTime"])
        self.assertIn("securityMaster", result)
        self.assertIn("regularizedModels", result)
        self.assertIn("treeModels", result)
