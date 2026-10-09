import unittest
import numpy as np
from ml import structure_neural as neural
from test_structure_neural import history, payload


class TimeframeTests(unittest.TestCase):
    def test_contract_and_defaults(self):
        body = payload(history(150))
        for tf, horizon, strength in (("1d", 1, 70), ("1w", 5, 80), ("1mo", 21, 90), ("1m", 21, 90)):
            request = {"snapshot": body["snapshot"], "timeframe": tf}
            h, options, _ = neural.validate_request(request)
            self.assertEqual(h, horizon)
            self.assertEqual(options["strength"], strength)
            with self.assertRaises(ValueError):
                neural.validate_request({**request, "horizon": 252})

    def test_partial_period_uses_only_observed_bars(self):
        frame = history(1500)
        for tf in ("1w", "1mo"):
            prefix = frame.iloc[:-3]
            bars = neural.level_history(prefix, tf)
            group = prefix.loc[bars.index[-1]:]
            self.assertEqual(bars.Close.iloc[-1], prefix.Close.iloc[-1])
            self.assertEqual(bars.High.iloc[-1], group.High.max())
            self.assertEqual(bars.Volume.iloc[-1], group.Volume.sum())
            changed = frame.copy()
            changed.iloc[-3:] *= 100
            np.testing.assert_array_equal(bars, neural.level_history(changed.iloc[:-3], tf))

    def test_weekly_monthly_features_do_not_see_future(self):
        # Only the end of this sample has sufficient monthly context (60 months).
        frame = history(1320)
        altered = frame.copy()
        altered.iloc[1300:] *= 4
        for tf in ("1w", "1mo"):
            h, _, s, d, g = neural.TIMEFRAMES[tf]
            options = {"timeframe": tf, "strength": s, "min_pct": d, "gap_pct": g}
            first = neural.dataset(frame, h, options)["trend"]
            second = neural.dataset(altered, h, options)["trend"]
            self.assertGreater(len(first[0]), 0)
            np.testing.assert_array_equal(first[2], second[2])
            np.testing.assert_allclose(first[0][first[2] < 1300], second[0][second[2] < 1300])
            np.testing.assert_array_equal(first[1][first[2] + h < 1300], second[1][second[2] + h < 1300])


if __name__ == "__main__":
    unittest.main()
