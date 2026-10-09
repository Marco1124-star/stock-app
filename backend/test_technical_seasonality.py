import unittest
import numpy as np
import pandas as pd

try:
    from ml.analysis_pages import (technical_series, technical_page_payload, monthly_returns,
                                   winsorize_curves, seasonality_page_payload, completed_daily_history)
except ImportError:
    from backend.ml.analysis_pages import (technical_series, technical_page_payload, monthly_returns,
                                           winsorize_curves, seasonality_page_payload, completed_daily_history)


def frame(n=1300):
    index = pd.bdate_range("2019-01-01", periods=n)
    close = 100 * np.exp(np.cumsum(np.random.default_rng(44).normal(.0002, .01, n)))
    return pd.DataFrame({"Open": close, "High": close * 1.01, "Low": close * .99,
                         "Close": close, "Volume": 1000.}, index=index)


class TechnicalSeasonalityTests(unittest.TestCase):
    def test_ma_macd_atr_formulas_independently(self):
        data = frame(240)
        values, _, _ = technical_series(data)
        close = data.Close.to_numpy()
        def ema(values, n):
            state, result = values[0], [values[0]]
            for value in values[1:]:
                state = (2 * value + (n - 1) * state) / (n + 1)
                result.append(state)
            return np.array(result)
        macd = ema(close, 12) - ema(close, 26)
        self.assertAlmostEqual(values.MACD.iloc[-1], macd[-1])
        self.assertAlmostEqual(values.MACD_Hist.iloc[-1], macd[-1] - ema(macd, 9)[-1])
        self.assertAlmostEqual(values.SMA50.iloc[-1], close[-50:].mean())
        self.assertAlmostEqual(values.EMA50.iloc[-1], ema(close, 50)[-1])
        weights = np.arange(1, 21)
        self.assertAlmostEqual(values.WMA20.iloc[-1], sum(close[-20:] * weights) / sum(weights))
        highs, lows = data.High.to_numpy(), data.Low.to_numpy()
        ranges = [max(highs[i] - lows[i], abs(highs[i] - close[i-1]), abs(lows[i] - close[i-1]))
                  for i in range(len(close)-14, len(close))]
        self.assertAlmostEqual(values.ATR14.iloc[-1], np.mean(ranges))

    def test_outlier_filter_matches_page_floor_percentiles_without_deleting_months(self):
        raw = list(np.arange(36, dtype=float) - 17.5)
        raw[0], raw[-1] = -500., 500.
        curves = {year: raw[i*12:(i+1)*12] for i, year in enumerate((2020, 2021, 2022))}
        filtered, audit = winsorize_curves(curves)
        expected = [min(max(v, raw[1]), raw[33]) for v in raw]
        self.assertEqual([v for row in filtered.values() for v in row], expected)
        self.assertEqual(audit["limited"], 3)
        self.assertEqual(audit["observations"], 36)
        self.assertEqual(sum(len(c) for c in filtered.values()), 36)
        self.assertEqual(curves[2020][0], -500.)

    def test_monthly_return_is_previous_month_close_not_mean_daily_return(self):
        dates = pd.to_datetime(["2020-12-01", "2020-12-31", "2021-01-04", "2021-01-29", "2021-02-01", "2021-02-26"])
        data = pd.DataFrame({"Close": [80., 100., 102., 110., 112., 121.]}, index=dates)
        returns = monthly_returns(data)
        self.assertTrue(pd.isna(returns.iloc[0]))
        self.assertEqual(returns.iloc[1:].tolist(), [10., 10.])
        data.loc[pd.Timestamp("2021-04-30")] = 150.
        returns = monthly_returns(data)
        self.assertTrue(pd.isna(returns.loc["2021-03-31"]))
        self.assertTrue(pd.isna(returns.loc["2021-04-30"]))

    def test_timezone_and_today_exclusion_shared_by_pages(self):
        data = frame(5)
        data.index = pd.date_range("2026-09-10 16:00", periods=5, tz="UTC").tz_localize(None)
        data.attrs.update(timestampTimezone="UTC", exchangeTimezoneName="Asia/Tokyo")
        result = completed_daily_history(data, "2026-09-14")
        self.assertEqual(result.index[-1], pd.Timestamp("2026-09-13"))
        self.assertEqual(len(result), 3)
        pd.testing.assert_frame_equal(completed_daily_history(result, "2026-09-14"), result)
        data.attrs["exchangeTimezoneName"] = "America/New_York"
        result = completed_daily_history(data, "2026-09-14")
        pd.testing.assert_frame_equal(completed_daily_history(result, "2026-09-14"), result)

if __name__ == "__main__":
    unittest.main()
