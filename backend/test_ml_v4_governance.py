import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ml.model_governance import audit_candidate_artifact


def _valid_model():
    return {
        "modelType": "ridge",
        "publishable": True,
        "validationStatus": "validated",
        "selection": {
            "holdoutUsedForSelection": False,
            "validationStatus": "validated",
        },
        "performance": {
            "validationStatus": "validated",
            "mae": 0.08,
            "baselineZeroMae": 0.10,
            "crossSectionalRankIcMean": 0.04,
            "interval80Coverage": 0.82,
            "blockBootstrap95": {
                "available": True,
                "method": "circularMovingBlockBootstrapByCalendarMonth",
                "confidenceLevel": 0.95,
                "iterations": 300,
                "intervals": {
                    "maeEdgeVsZero": {"lower": 0.001, "upper": 0.03},
                },
            },
            "nonOverlappingRobustness": {
                "available": True,
                "method": "calendarPhaseSubsamples",
                "phaseCount": 3,
                "maeEdgeVsZeroMinimum": 0.001,
            },
        },
        # Queste alternative devono essere ignorate dalla governance.
        "candidatePerformance": {
            "xgboost": {"publishable": False},
        },
        "fallbackModel": {
            "modelType": "not-installed",
            "publishable": False,
        },
    }


def _valid_artifact():
    return {
        "modelVersion": "candidate-v4",
        "validationVersion": "cross-sectional-block-bootstrap-v4",
        "generatedAt": "2026-08-09T12:00:00Z",
        "models": {
            horizon: _valid_model()
            for horizon in ("1m", "3m", "1y")
        },
    }


class ModelGovernanceTests(unittest.TestCase):
    def test_valid_candidate_is_promoted_without_reading_alternatives(self):
        result = audit_candidate_artifact(_valid_artifact())

        self.assertEqual(result["decision"], "promote")
        self.assertTrue(result["eligible"])
        self.assertTrue(result["policy"]["candidateOnly"])
        for horizon in ("1m", "3m", "1y"):
            self.assertEqual(result["horizons"][horizon]["decision"], "promote")
            self.assertEqual(
                result["horizons"][horizon]["diagnostics"]["bootstrapCi95"][
                    "status"
                ],
                "available",
            )

    def test_legacy_artifact_is_rejected_for_each_required_horizon(self):
        artifact = _valid_artifact()
        artifact["validationVersion"] = "rank-ic-relative-v3"

        result = audit_candidate_artifact(artifact)

        self.assertEqual(result["decision"], "reject")
        for horizon in ("1m", "3m", "1y"):
            checks = {
                item["gate"]: item
                for item in result["horizons"][horizon]["checks"]
            }
            self.assertFalse(checks["validation_version_v4"]["passed"])
            self.assertIn("legacy", checks["validation_version_v4"]["reason"])

    def test_holdout_leakage_rejects_even_otherwise_valid_candidate(self):
        artifact = _valid_artifact()
        artifact["models"]["3m"]["selection"][
            "holdoutUsedForSelection"
        ] = True

        result = audit_candidate_artifact(artifact)
        checks = {
            item["gate"]: item
            for item in result["horizons"]["3m"]["checks"]
        }

        self.assertEqual(result["decision"], "reject")
        self.assertEqual(result["horizons"]["1m"]["decision"], "promote")
        self.assertEqual(result["horizons"]["3m"]["decision"], "reject")
        self.assertFalse(checks["holdout_not_used_for_selection"]["passed"])

    def test_partially_valid_candidate_reports_only_failing_horizons(self):
        artifact = _valid_artifact()
        artifact["models"]["3m"]["performance"]["interval80Coverage"] = 0.68
        artifact["models"]["1y"]["performance"][
            "crossSectionalRankIcMean"
        ] = 0.0
        artifact["models"]["1y"]["performance"].pop("blockBootstrap95")
        artifact["models"]["1y"]["performance"][
            "nonOverlappingRobustness"
        ] = {"available": False, "reason": "Campione troppo corto."}

        result = audit_candidate_artifact(artifact)

        self.assertEqual(result["decision"], "reject")
        self.assertEqual(result["horizons"]["1m"]["decision"], "promote")
        self.assertEqual(result["horizons"]["3m"]["decision"], "reject")
        self.assertEqual(result["horizons"]["1y"]["decision"], "reject")
        bootstrap = result["horizons"]["1y"]["diagnostics"]["bootstrapCi95"]
        non_overlap = result["horizons"]["1y"]["diagnostics"][
            "nonOverlappingRobustness"
        ]
        self.assertEqual(bootstrap["status"], "missing")
        self.assertNotIn("passed", bootstrap)
        self.assertEqual(non_overlap["status"], "unavailable")
        self.assertNotIn("passed", non_overlap)

    def test_missing_horizon_is_transparently_rejected(self):
        artifact = _valid_artifact()
        artifact["models"].pop("1y")

        result = audit_candidate_artifact(artifact)

        self.assertEqual(result["horizons"]["1y"]["decision"], "reject")
        self.assertIn("mancante", result["horizons"]["1y"]["reasons"][0])

    def test_cli_is_read_only_and_uses_documented_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "candidate.json"
            artifact_path.write_text(
                json.dumps(_valid_artifact()),
                encoding="utf-8",
            )
            before = artifact_path.read_bytes()
            promoted = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ml.model_governance",
                    str(artifact_path),
                ],
                cwd=Path(__file__).resolve().parent,
                capture_output=True,
                text=True,
                check=False,
            )
            promoted_output = json.loads(promoted.stdout)

            self.assertEqual(promoted.returncode, 0)
            self.assertEqual(promoted_output["decision"], "promote")
            self.assertEqual(artifact_path.read_bytes(), before)

            rejected_artifact = _valid_artifact()
            rejected_artifact["models"]["1m"]["publishable"] = False
            artifact_path.write_text(
                json.dumps(rejected_artifact),
                encoding="utf-8",
            )
            rejected = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ml.model_governance",
                    str(artifact_path),
                ],
                cwd=Path(__file__).resolve().parent,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(rejected.returncode, 2)
            self.assertEqual(json.loads(rejected.stdout)["decision"], "reject")


if __name__ == "__main__":
    unittest.main()
