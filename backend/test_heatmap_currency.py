"""Deterministic FX arithmetic and cross-exchange availability tests."""
import importlib
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

try:
    app_module = importlib.import_module("app")
except ModuleNotFoundError:
    app_module = importlib.import_module("backend.app")


class HeatmapCurrencyTests(unittest.TestCase):
    def test_fx_chart_utc_timestamps_use_local_session_date(self):
        dates = pd.bdate_range("2025-06-02", periods=70)
        utc_dates = dates.tz_localize("Europe/London").tz_convert("UTC").tz_localize(None)
        frame = pd.DataFrame({"Close": 1., "Adj Close": 1.}, index=utc_dates)
        frame.attrs.update(timestampTimezone="UTC", exchangeTimezoneName="Europe/London")
        app_module.heatmap_prices_cache.clear()
        with patch.object(app_module, "_fetch_interval_history", return_value=frame):
            series, _ = app_module._heatmap_relation_history("USDEUR=X")
        pd.testing.assert_index_equal(series.index, dates, check_names=False)
        self.assertFalse(any(series.index.dayofweek == 6))
        app_module.heatmap_prices_cache.clear()

    def test_quote_currency_falls_back_to_chart_not_financial_currency(self):
        with patch.object(app_module, "_fetch_quote_fields", return_value={}), \
             patch.object(app_module, "_fetch_quote_page_fields", return_value={}), \
             patch.object(app_module, "_safe_get_info", return_value={"sector": "Energy", "financialCurrency": "USD"}), \
             patch.object(app_module, "_fetch_chart_data", return_value=(pd.DataFrame(), {"currency": "EUR"})):
            metadata = app_module._heatmap_sector_metadata("ENI.MI")
        self.assertEqual(metadata["symbol"], "ENI.MI")
        self.assertEqual(metadata["currency"], "EUR")

    def test_conversion_compounds_stock_and_fx_returns(self):
        dates = pd.date_range("2025-01-01", periods=3)
        prices = pd.Series([100., 110., 120.], index=dates)
        prices.attrs["priceBasis"] = "adjusted"
        fx = pd.Series([1., .95], index=dates[:2])
        actual = app_module._heatmap_convert_usd(prices, fx)
        self.assertAlmostEqual(actual.iloc[1] / actual.iloc[0] - 1, .045)
        self.assertTrue(pd.isna(actual.iloc[2]))
        self.assertEqual(actual.attrs["priceBasis"], "adjusted")
        self.assertEqual(prices.iloc[1], 110.)  # Cached input not mutated.

    def test_minor_units_are_not_confused_with_exchange_rates(self):
        for quote, expected in (("GBp", ("GBP", .01)), ("GBX", ("GBP", .01)),
                                ("GBP", ("GBP", 1.)), ("ZAc", ("ZAR", .01)),
                                ("ILA", ("ILS", .01)), ("EUR", ("EUR", 1.)),
                                (None, (None, None))):
            self.assertEqual(app_module._heatmap_currency(quote), expected)

    def test_inverse_fx_fallback_and_invalid_quotes(self):
        dates = pd.bdate_range("2025-01-01", periods=60)
        inverse = pd.Series(2., index=dates)
        inverse.iloc[2] = 0
        inverse.iloc[3] = np.inf
        with patch.object(app_module, "_heatmap_relation_history", side_effect=[
            (pd.Series(dtype=float), None), (inverse, "EURUSD=X")
        ]):
            rates, info = app_module._heatmap_usd_fx("EUR")
        self.assertEqual(info["symbol"], "EURUSD=X")
        self.assertTrue(info["inverse"])
        self.assertEqual(rates.iloc[0], .5)
        self.assertTrue(rates.iloc[2:4].isna().all())

    def test_foreign_same_day_close_is_never_a_feature(self):
        dates = pd.to_datetime(["2025-01-03", "2025-01-06", "2025-01-07"])
        prices = pd.Series([10., np.nan, 999.], index=dates)
        calendar = pd.to_datetime(["2025-01-06", "2025-01-07", "2025-01-13"])
        aligned = app_module._heatmap_prior_close(prices, calendar)
        self.assertEqual(aligned.iloc[0], 10.)
        self.assertTrue(pd.isna(aligned.iloc[1]))  # Never skip invalid prior bar.
        self.assertTrue(pd.isna(aligned.iloc[2]))  # Never carry a stale close.


if __name__ == "__main__":
    unittest.main()
