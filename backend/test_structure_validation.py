"""Offline validation invariants; synthetic fixtures do not establish predictive edge."""
import unittest
from unittest.mock import Mock

import numpy as np
import pandas as pd

from ml import structure_validation as validation


def independent_date_means(values, times):
    """Small scalar reference, independent of the production grouping helpers."""
    grouped = {}
    for value, date in zip(values, times):
        grouped.setdefault(int(date), []).append(float(value))
    return np.array([sum(grouped[date]) / len(grouped[date]) for date in sorted(grouped)])


class DateGroupingTests(unittest.TestCase):
    def test_shorter_incumbent_with_missing_classes_cannot_crash_probability_mapping(self):
        times = np.arange(2400, 4000)
        labels = np.zeros(len(times), dtype=int)
        labels[:90] = np.arange(90) % 3
        x = np.zeros((len(times), 9))
        dates = pd.bdate_range("2010-01-01", periods=4005)
        fit = Mock(side_effect=AssertionError("Invalid comparator must be rejected before fitting"))
        report, estimate = validation.evaluate_pipeline((x, labels, times), x[-1:], 5, 3700, 3, dates, fit, Mock())
        self.assertEqual(report["status"], "unavailable")
        self.assertIn("rete precedente", report["reason"])
        self.assertIsNone(estimate)
        fit.assert_not_called()

    def test_weights_give_each_date_equal_total_weight_and_rows_mean_one(self):
        times = np.array([9, 3, 9, 1, 3, 9, 5])
        values = np.array([90., 10., 30., -4., 30., 60., 8.])
        weights = validation.date_weights(times)
        counts = {date: list(times).count(date) for date in set(times)}
        expected = np.array([len(times) / (len(counts) * counts[date]) for date in times])
        np.testing.assert_allclose(weights, expected)
        self.assertAlmostEqual(weights.mean(), 1.)
        for date in counts:
            self.assertAlmostEqual(weights[times == date].sum(), len(times) / len(counts))
        reference = independent_date_means(values, times)
        np.testing.assert_allclose(validation.by_date(values, times), reference)
        self.assertAlmostEqual(np.average(values, weights=weights), reference.mean())

    def test_replicating_one_dates_rows_does_not_change_equal_date_result(self):
        times = np.array([10, 10, 20, 30])
        values = np.array([0., 2., 8., 4.])
        repeat = np.array([7, 7, 1, 1])
        repeated_times = np.repeat(times, repeat)
        repeated_values = np.repeat(values, repeat)
        expected = (1. + 8. + 4.) / 3
        self.assertAlmostEqual(validation.by_date(repeated_values, repeated_times).mean(), expected)
        self.assertAlmostEqual(np.average(repeated_values, weights=validation.date_weights(repeated_times)), expected)
        self.assertNotAlmostEqual(repeated_values.mean(), expected)

    def test_spaced_dates_use_actual_irregular_anchors_not_row_positions(self):
        times = np.array([34, 1, 2, 2, 7, 8, 13, 14, 22, 23, 33, 34])
        np.testing.assert_array_equal(validation.spaced_dates(times, 5), [1, 7, 13, 22, 33])
        np.testing.assert_array_equal(validation.spaced_dates(times, 0), sorted(set(times)))
        result = validation.spaced_dates(np.array([], dtype=int), 5)
        self.assertEqual(result.size, 0)
        self.assertTrue(np.issubdtype(result.dtype, np.integer))


class PurgedFoldTests(unittest.TestCase):
    def test_folds_keep_whole_dates_and_all_label_intervals_separate(self):
        anchors = np.cumsum(1 + 3 * (np.arange(820) % 11 == 0))
        times = np.repeat(anchors, 1 + np.arange(len(anchors)) % 4)
        times = np.random.default_rng(33).permutation(times)
        for horizon in (1, 5, 21):
            with self.subTest(horizon=horizon):
                folds = validation.purged_folds(times, horizon)
                self.assertEqual(len(folds), 3)
                all_validation_dates = []
                for train, test in folds:
                    self.assertEqual(train.dtype, np.dtype(bool))
                    self.assertEqual(test.dtype, np.dtype(bool))
                    self.assertEqual(train.shape, times.shape)
                    self.assertEqual(test.shape, times.shape)
                    self.assertFalse(np.any(train & test))
                    train_dates = sorted(set(times[train]))
                    test_dates = sorted(set(times[test]))
                    self.assertGreaterEqual(len(train_dates), 300)
                    self.assertLess(max(train_dates) + horizon, min(test_dates))
                    for date in anchors:
                        members = times == date
                        self.assertIn(int(train[members].sum()), (0, int(members.sum())))
                        self.assertIn(int(test[members].sum()), (0, int(members.sum())))
                    all_validation_dates.extend(test_dates)
                # Includes the boundary between successive validation folds.
                self.assertEqual(len(all_validation_dates), len(set(all_validation_dates)))
                for previous, current in zip(all_validation_dates, all_validation_dates[1:]):
                    self.assertGreater(current, previous + horizon)

    def test_many_rows_do_not_replace_sufficient_unique_dates(self):
        self.assertEqual(validation.purged_folds(np.repeat(np.arange(389), 10), 5), [])
        self.assertEqual(validation.purged_folds(np.arange(450), 200), [])


class CalibrationTests(unittest.TestCase):
    def test_temperature_scaling_is_finite_normalized_and_preserves_order(self):
        probabilities = np.array([[.97, .02, .01], [0., 0., 1.], [1e-30, .4, .6]])
        for temperature in (.75, 1., 3.):
            with self.subTest(temperature=temperature):
                scaled = validation.temperature_scale(probabilities, temperature)
                self.assertTrue(np.isfinite(scaled).all())
                self.assertTrue((scaled > 0).all())
                np.testing.assert_allclose(scaled.sum(axis=1), 1.)
                np.testing.assert_array_equal(scaled.argmax(axis=1), probabilities.argmax(axis=1))
        positive = np.array([[.6, .25, .15], [.2, .35, .45]])
        np.testing.assert_allclose(validation.temperature_scale(positive, 1.), positive)
        softer = validation.temperature_scale(positive, 3.)
        self.assertTrue(np.all(softer.max(axis=1) < positive.max(axis=1)))

    def test_overconfident_synthetic_probabilities_calibrate_to_lower_log_loss(self):
        anchors = np.arange(90)
        predicted = anchors % 3
        labels = np.where(anchors % 5 == 0, (predicted + 1) % 3, predicted)
        probabilities = np.full((90, 3), .0025)
        probabilities[np.arange(90), predicted] = .995
        repetitions = 1 + anchors % 4
        times = np.repeat(anchors * 6, repetitions)
        labels = np.repeat(labels, repetitions)
        probabilities = np.repeat(probabilities, repetitions, axis=0)
        result = validation.calibrate(probabilities, labels, times)
        self.assertEqual(result["method"], "temperature")
        self.assertEqual(result["windows"], 90)
        self.assertGreater(result["temperature"], 1.)
        self.assertLessEqual(result["temperature"], 3.)
        scaled = validation.temperature_scale(probabilities, result["temperature"])
        before = -np.log(probabilities[np.arange(len(labels)), labels])
        after = -np.log(scaled[np.arange(len(labels)), labels])
        self.assertLess(independent_date_means(after, times).mean(),
                        independent_date_means(before, times).mean() - .1)

    def test_calibration_declines_insufficient_unique_windows_despite_many_rows(self):
        times = np.repeat(np.arange(19), 30)
        labels = np.arange(len(times)) % 3
        probabilities = np.tile([.98, .01, .01], (len(times), 1))
        self.assertEqual(validation.calibrate(probabilities, labels, times),
                         {"method": "identity", "temperature": 1., "windows": 19})

    def test_calibration_declines_missing_classes_and_no_improvement(self):
        times = np.arange(60)
        probabilities = np.full((60, 3), 1. / 3)
        for labels in (times % 2, times % 3):
            with self.subTest(classes=len(set(labels))):
                self.assertEqual(validation.calibrate(probabilities, labels, times),
                                 {"method": "identity", "temperature": 1., "windows": 60})


class CurrentQualityTests(unittest.TestCase):
    def setUp(self):
        varying = np.linspace(-1., 1., 101)
        self.fitted = np.column_stack((varying, varying[::-1], np.full(101, 5.)))

    def test_two_outside_features_or_a_changed_constant_feature_are_ood(self):
        current = np.array([[0., 0., 5.], [10., 10., 5.], [10., 0., 5.], [0., 0., 6.]])
        probabilities = np.tile([.8, .1, .1], (4, 1))
        result = validation.current_quality(probabilities, [probabilities], self.fitted, current)
        self.assertEqual([row["outOfDistribution"] for row in result], [False, True, False, True])
        self.assertEqual([row["abstain"] for row in result], [False, True, False, True])
        self.assertEqual([row["disagreementPct"] for row in result], [0.] * 4)
        for index in (1, 3):
            self.assertIn("fuori dal dominio", result[index]["reason"])

    def test_low_confidence_abstains_and_threshold_confidence_is_accepted(self):
        probabilities = np.array([[.599, .25, .151], [.6, .25, .15], [.52, .4, .08]])
        current = np.tile([0., 0., 5.], (3, 1))
        result = validation.current_quality(probabilities, [probabilities], self.fitted, current)
        self.assertEqual([row["abstain"] for row in result], [True, False, True])
        self.assertTrue(all(not row["outOfDistribution"] for row in result))
        self.assertAlmostEqual(result[0]["confidencePct"], 59.9)
        self.assertIn("insufficienti", result[0]["reason"])

    def test_member_disagreement_abstains_even_when_mean_is_confident(self):
        probabilities = np.array([[.7, .2, .1]])
        members = [np.array([[.85, .1, .05]]), np.array([[.55, .3, .15]])]
        result = validation.current_quality(probabilities, members, self.fitted, np.array([[0., 0., 5.]]))[0]
        self.assertTrue(result["abstain"])
        self.assertFalse(result["outOfDistribution"])
        self.assertAlmostEqual(result["disagreementPct"], 30.)
        self.assertIn("disaccordo", result["reason"])

    def test_no_current_rows_needs_no_member_predictions(self):
        result = validation.current_quality(np.empty((0, 3)), [], self.fitted, np.empty((0, 3)))
        self.assertEqual(result, [])


class PipelineCausalityTests(unittest.TestCase):
    @staticmethod
    def callbacks():
        fits = []

        def fit_network(x, y, hidden=(16, 8), alpha=1., seed=0, sample_weight=None):
            # Tiny label-sensitive probability tables replace costly network fits.
            # Candidate confidence differs, so selection and calibration do real work.
            states = x[:, :3].argmax(axis=1)
            weights = np.ones(len(y)) if sample_weight is None else sample_weight
            counts = np.ones((3, 3))
            np.add.at(counts, (states, y), weights)
            probabilities = counts / counts.sum(axis=1, keepdims=True)
            probabilities **= 4. if hidden == (16, 8) else 1.8
            probabilities /= probabilities.sum(axis=1, keepdims=True)
            fits.append({"times": x[:, 3].copy(), "labels": y.copy(), "probabilities": probabilities.copy()})
            return probabilities, True

        def predict_network(fitted, x, classes):
            if classes != 3:
                raise ValueError("This synthetic fixture has three classes.")
            return fitted[0][x[:, :3].argmax(axis=1)].copy()

        return fit_network, predict_network, fits

    def test_holdout_label_changes_cannot_choose_model_or_validation_calibration(self):
        rng = np.random.default_rng(618)
        anchors = np.arange(1000)
        states = rng.integers(0, 3, len(anchors))
        labels = np.where(rng.random(len(anchors)) < .2, (states + 1) % 3, states)
        repetitions = 1 + anchors % 3
        x = np.repeat(np.column_stack((np.eye(3)[states], anchors)), repetitions, axis=0)
        times = np.repeat(anchors, repetitions)
        y = np.repeat(labels, repetitions)
        boundary, horizon = 700, 5
        changed = y.copy()
        final_holdout = times >= boundary
        changed[final_holdout] = (x[final_holdout, :3].argmax(axis=1) + 2) % 3
        latest = np.column_stack((np.eye(3), np.full(3, 1000.)))
        dates = pd.bdate_range("2020-01-01", periods=1010)

        fit, predict, original_fits = self.callbacks()
        report, estimate = validation.evaluate_pipeline((x, y, times), latest, horizon,
                                                        boundary, 3, dates, fit, predict)
        fit_changed, predict_changed, changed_fits = self.callbacks()
        changed_report, changed_estimate = validation.evaluate_pipeline(
            (x, changed, times), latest, horizon, boundary, 3, dates, fit_changed, predict_changed)

        for result in (report, changed_report):
            self.assertIn(result["status"], ("experimental", "validated"))
            self.assertEqual(result["modelSelection"]["folds"], 3)
            self.assertTrue({"legacy", "compact", "ensemble", "linear"}.issubset(
                result["modelSelection"]["developmentBrier"]))
            self.assertGreaterEqual(result["modelSelection"]["validationCalibration"]["windows"], 20)
            self.assertLess(result["validation"]["trainLabelEnd"], result["validation"]["start"])
        selection = report["modelSelection"]
        changed_selection = changed_report["modelSelection"]
        self.assertIn(selection["candidate"], selection["developmentBrier"])
        self.assertIn(selection["validationCalibration"]["method"], ("temperature", "identity"))
        for field in ("candidate", "validationCalibration", "developmentBrier", "foldAudit"):
            with self.subTest(frozen_field=field):
                self.assertEqual(selection[field], changed_selection[field])
        # Prove the perturbation was material and reached the holdout report/refit.
        self.assertTrue(np.all(y[final_holdout] != changed[final_holdout]))
        self.assertNotAlmostEqual(report["validation"]["brier"], changed_report["validation"]["brier"])
        self.assertFalse(np.array_equal(original_fits[-1]["labels"], changed_fits[-1]["labels"]))
        self.assertFalse(np.allclose(original_fits[-1]["probabilities"], changed_fits[-1]["probabilities"]))
        for values in (estimate, changed_estimate):
            self.assertEqual(values.shape, (3, 3))
            np.testing.assert_allclose(values.sum(axis=1), 1.)


if __name__ == "__main__":
    unittest.main()
