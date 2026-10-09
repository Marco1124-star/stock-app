"""API contract: real forecasting engine, mocked market provider only."""
import importlib
import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

try:
    app_module = importlib.import_module("app")
except ModuleNotFoundError:
    app_module = importlib.import_module("backend.app")


class HeatmapSignalAPITests(unittest.TestCase):
    def setUp(self):
        app_module.heatmap_relations_cache.clear()
        app_module.heatmap_prices_cache.clear()
        app_module.stock_response_cache.clear()
        self.client = app_module.app.test_client()
        self.rows = [
            {"symbol": "AAA", "sector": "Technology", "marketCap": 20},
            {"symbol": "BBB", "sector": "Information Technology", "marketCap": 10},
            {"symbol": "CCC", "sector": "Technology", "marketCap": 8},
        ]
        self.dates = pd.bdate_range(end=pd.Timestamp.now(tz="UTC").tz_localize(None).normalize() - pd.Timedelta(days=1), periods=850)
        self.price_basis = "adjusted"
        self.provider = patch.object(app_module, "tradingview_heatmap", side_effect=lambda: app_module.jsonify({"rows": self.rows}))
        self.history = patch.object(app_module, "_heatmap_relation_history", side_effect=self.prices)
        self.metadata = patch.object(app_module, "_heatmap_sector_metadata", return_value={"currency": "USD"})
        for patched in (self.provider, self.history, self.metadata):
            patched.start()
            self.addCleanup(patched.stop)

    def prices(self, symbol):
        rng = np.random.default_rng(sum(map(ord, symbol)))
        series = pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0001, 0.01, len(self.dates)))), index=self.dates)
        series.attrs["priceBasis"] = self.price_basis
        return series, symbol

    def test_new_schema_and_costs_reach_all_three_forecasts(self):
        response = self.client.get("/market/heatmap-relations/AAA?signalCostBps=35&signalVersion=forward-ridge-v1")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["signalVersion"], "forward-ridge-v1")
        self.assertEqual(payload["peerCount"], 2)
        self.assertEqual(set(payload["signals"]), {"daily", "monthly", "annual"})
        for signal in payload["signals"].values():
            self.assertEqual(signal["version"], "forward-ridge-v1")
            self.assertEqual(signal["costBps"], 35)
            self.assertNotIn("scorePct", signal)
        json.dumps(payload, allow_nan=False)

    def test_old_cached_signal_does_not_hide_new_model(self):
        app_module._cache_set(app_module.heatmap_relations_cache, "heatmap-relations:v2:AAA:other", {"signals": {"daily": {"label": "Neutro"}}})
        payload = self.client.get("/market/heatmap-relations/AAA").get_json()
        self.assertEqual(payload["signalVersion"], "forward-ridge-v1")
        self.assertEqual(payload["signals"]["daily"]["version"], "forward-ridge-v1")

    def test_cost_changes_are_not_served_from_wrong_cache(self):
        low = self.client.get("/market/heatmap-relations/AAA?signalCostBps=0").get_json()
        high = self.client.get("/market/heatmap-relations/AAA?signalCostBps=500").get_json()
        self.assertEqual(low["signals"]["daily"]["costBps"], 0)
        self.assertEqual(high["signals"]["daily"]["costBps"], 500)
        self.assertAlmostEqual(low["signals"]["daily"]["forecastReturnPct"], high["signals"]["daily"]["forecastReturnPct"])

    def test_invalid_costs_and_unknown_versions_fail_before_download(self):
        with patch.object(app_module, "_heatmap_relation_history") as download:
            for cost in ("nan", "-1", "501", "abc"):
                self.assertEqual(self.client.get(f"/market/heatmap-relations/AAA?signalCostBps={cost}").status_code, 400)
            self.assertEqual(self.client.get("/market/heatmap-relations/AAA?signalVersion=unknown").status_code, 409)
            download.assert_not_called()

    def test_unadjusted_prices_do_not_get_executable_recommendations(self):
        self.price_basis = "close"
        payload = self.client.get("/market/heatmap-relations/AAA").get_json()
        for signal in payload["signals"].values():
            self.assertEqual(signal["action"], "unavailable")
            self.assertEqual(signal["status"], "incompatible_data")

    def test_ticker_suffix_is_not_silently_replaced_by_another_listing(self):
        with patch.object(app_module, "_heatmap_sector_metadata", return_value={"symbol": "AAA.MI", "sector": "Technology", "currency": "EUR"}):
            payload = self.client.get("/market/heatmap-relations/AAA.MI").get_json()
        self.assertEqual(payload["target"]["symbol"], "AAA.MI")
        self.assertEqual(payload["target"]["currency"], "EUR")
        self.assertFalse(payload["target"]["inHeatmap"])
        self.assertEqual(payload["dataQuality"]["fx"]["symbol"], "USDEUR=X")
        self.assertNotEqual(payload["signals"]["daily"]["status"], "incompatible_data")
        self.assertIsNotNone(payload["signals"]["daily"]["forecastReturnPct"])

    def test_model_survives_heatmap_outage_for_foreign_listing(self):
        with patch.object(app_module, "tradingview_heatmap", side_effect=lambda: (app_module.jsonify({"error": "offline"}), 502)), \
             patch.object(app_module, "_heatmap_sector_metadata", return_value={"symbol": "7203.T", "sector": "Consumer Cyclical", "currency": "JPY"}):
            response = self.client.get("/market/heatmap-relations/7203.T")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["target"]["currency"], "JPY")
        self.assertEqual(payload["peerCount"], 0)
        self.assertEqual(payload["sectorReference"]["etf"], "XLY")
        self.assertIsNotNone(payload["signals"]["daily"]["forecastReturnPct"])

    def test_missing_fx_blocks_mixed_currency_statistics_and_signals(self):
        with patch.object(app_module, "_heatmap_sector_metadata", return_value={"symbol": "AAA.MI", "sector": "Technology", "currency": "EUR"}), \
             patch.object(app_module, "_heatmap_usd_fx", return_value=(pd.Series(dtype=float), None)):
            payload = self.client.get("/market/heatmap-relations/AAA.MI").get_json()
        self.assertEqual(payload["signals"]["daily"]["status"], "incompatible_data")
        self.assertEqual(payload["peerCorrelations"]["daily"], [])
        self.assertEqual(payload["sectorCorrelations"]["daily"], [])
        self.assertIn("Cambio storico", payload["signals"]["daily"]["reasons"][0])

    def test_unknown_currency_is_not_assumed_usd(self):
        with patch.object(app_module, "_heatmap_sector_metadata", return_value={}):
            payload = self.client.get("/market/heatmap-relations/AAA").get_json()
        self.assertIsNone(payload["target"]["currency"])
        self.assertEqual(payload["signals"]["daily"]["status"], "incompatible_data")

    def test_pence_listing_and_usd_listing_outside_heatmap(self):
        for symbol, quote, expected in (("AAA.L", "GBp", "GBP"), ("DDD", "USD", "USD")):
            with patch.object(app_module, "_heatmap_sector_metadata", return_value={"symbol": symbol, "sector": "Technology", "currency": quote}):
                payload = self.client.get(f"/market/heatmap-relations/{symbol}").get_json()
            self.assertEqual(payload["target"]["currency"], expected)
            self.assertIsNotNone(payload["signals"]["daily"]["forecastReturnPct"])

    def test_missing_latest_fx_does_not_produce_a_fresh_signal(self):
        rates, _ = self.prices("USDEUR=X")
        rates.iloc[-8:] = np.nan
        with patch.object(app_module, "_heatmap_sector_metadata", return_value={"symbol": "AAA.MI", "sector": "Technology", "currency": "EUR"}), \
             patch.object(app_module, "_heatmap_usd_fx", return_value=(rates, {"symbol": "USDEUR=X"})):
            payload = self.client.get("/market/heatmap-relations/AAA.MI").get_json()
        self.assertEqual(payload["signals"]["daily"]["status"], "stale_data")

    def test_industry_named_sector_uses_quote_sector_and_keeps_its_peers(self):
        self.rows = [{"symbol": "AAA", "sector": "Electronic Technology", "marketCap": 20},
                     {"symbol": "BBB", "sector": "Electronic Technology", "marketCap": 10}]
        with patch.object(app_module, "_heatmap_sector_metadata", return_value={"sector": "Technology", "symbol": "AAA", "currency": "USD"}):
            payload = self.client.get("/market/heatmap-relations/AAA").get_json()
        self.assertEqual(payload["target"]["sector"], "Technology")
        self.assertEqual(payload["sectorReference"]["etf"], "XLK")
        self.assertEqual(payload["peerCount"], 1)


if __name__ == "__main__":
    unittest.main()
