import json
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd

import app as app_module
from app import (
    _json_safe,
    _market_snapshot_frame,
    _merge_daily_market_data,
    _prepare_ohlc_df,
    _price_metadata,
    _resample_ohlc_by_bar_count,
)


class HistoryPipelineTests(unittest.TestCase):
    def test_all_supported_daily_ranges_use_a_buffer_and_keep_one_return_seed(self):
        today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
        index = pd.date_range(
            today - pd.DateOffset(years=12),
            today - pd.Timedelta(days=1),
            freq="B",
        )
        values = np.linspace(25.0, 225.0, len(index))
        frame = pd.DataFrame(
            {
                "Open": values - 0.5,
                "High": values + 1.0,
                "Low": values - 1.0,
                "Close": values,
                "Adj Close": values * 0.95,
                "Volume": np.full(len(index), 500_000.0),
                "Dividends": np.zeros(len(index)),
                "Stock Splits": np.zeros(len(index)),
            },
            index=index,
        )
        cases = {
            "1y": (1, "2y"),
            "2y": (2, "5y"),
            "3y": (3, "5y"),
            "5y": (5, "10y"),
            "10y": (10, "max"),
        }

        for requested_range, (years, provider_range) in cases.items():
            with self.subTest(requested_range=requested_range):
                app_module.history_cache.clear()
                with (
                    patch.object(
                        app_module,
                        "ticker_candidates",
                        return_value=["RANGESET"],
                    ),
                    patch.object(app_module.yf, "Ticker"),
                    patch.object(
                        app_module,
                        "_fetch_interval_history",
                        return_value=frame,
                    ) as fetch_history,
                ):
                    response = app_module.app.test_client().get(
                        "/stock/rangeset/history"
                        f"?timeframe=1d&range={requested_range}"
                    )

                self.assertEqual(response.status_code, 200)
                payload = response.get_json()
                expected_start = today - pd.DateOffset(years=years)
                observations = payload["history"][1:]

                self.assertEqual(
                    fetch_history.call_args.args[2:],
                    (provider_range, "1d", provider_range),
                )
                self.assertEqual(payload["range"], requested_range)
                self.assertEqual(
                    payload["rangeStart"],
                    expected_start.date().isoformat(),
                )
                self.assertEqual(payload["rangeEnd"], today.date().isoformat())
                self.assertTrue(payload["includesPreviousClose"])
                self.assertLess(
                    payload["history"][0]["date"],
                    payload["rangeStart"],
                )
                self.assertGreaterEqual(
                    observations[0]["date"],
                    payload["rangeStart"],
                )
                self.assertEqual(payload["observationCount"], len(observations))
                self.assertEqual(payload["actualStart"], observations[0]["date"])
                self.assertEqual(payload["actualEnd"], observations[-1]["date"])
                self.assertEqual(
                    payload["adjustedCloseCount"],
                    payload["observationCount"],
                )
                self.assertEqual(payload["adjustedCloseCoveragePct"], 100.0)
                self.assertEqual(payload["corporateActionCount"], 0)
                self.assertEqual(payload["invalidRowsRemoved"], 0)
                self.assertEqual(payload["dataSource"], "Yahoo Finance")
                self.assertTrue(payload["generatedAt"].endswith("Z"))
                self.assertEqual(payload["priceField"], "adjustedClose")
                for key in (
                    "date",
                    "open",
                    "high",
                    "low",
                    "close",
                    "rawClose",
                    "adjustedClose",
                    "volume",
                    "dividend",
                    "stockSplit",
                ):
                    self.assertIn(key, observations[-1])

    def test_ranged_daily_history_excludes_potentially_open_current_bar(self):
        today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
        index = pd.date_range(end=today, periods=10, freq="D")
        values = np.linspace(10.0, 19.0, len(index))
        frame = pd.DataFrame(
            {
                "Open": values,
                "High": values + 1,
                "Low": values - 1,
                "Close": values,
                "Adj Close": values,
                "Volume": np.full(len(index), 1000),
            },
            index=index,
        )

        app_module.history_cache.clear()
        with (
            patch.object(app_module, "ticker_candidates", return_value=["TODAYBAR"]),
            patch.object(app_module.yf, "Ticker"),
            patch.object(app_module, "_fetch_interval_history", return_value=frame),
        ):
            response = app_module.app.test_client().get(
                "/stock/TODAYBAR/history?timeframe=1d&range=1y"
            )

        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["excludedPotentiallyIncompleteSession"])
        self.assertLess(payload["history"][-1]["date"], today.date().isoformat())

    def test_daily_history_can_return_exact_five_year_adjusted_window(self):
        today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
        expected_start = today - pd.DateOffset(years=5)
        index = pd.date_range(
            today - pd.DateOffset(years=6),
            today - pd.Timedelta(days=1),
            freq="B",
        )
        values = np.linspace(80.0, 180.0, len(index))
        frame = pd.DataFrame(
            {
                "Open": values - 1.0,
                "High": values + 2.0,
                "Low": values - 2.0,
                "Close": values,
                "Adj Close": values * 0.98,
                "Volume": np.full(len(index), 1_000_000),
            },
            index=index,
        )

        app_module.history_cache.clear()
        with (
            patch.object(app_module, "ticker_candidates", return_value=["RANGE5Y"]),
            patch.object(app_module.yf, "Ticker"),
            patch.object(
                app_module,
                "_fetch_interval_history",
                return_value=frame,
            ) as fetch_history,
        ):
            response = app_module.app.test_client().get(
                "/stock/RANGE5Y/history?timeframe=1d&range=5y"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["range"], "5y")
        self.assertEqual(payload["interval"], "1d")
        self.assertEqual(payload["priceField"], "adjustedClose")
        self.assertEqual(payload["rangeStart"], expected_start.date().isoformat())
        self.assertEqual(payload["rangeEnd"], today.date().isoformat())
        self.assertTrue(payload["includesPreviousClose"])
        self.assertGreater(len(payload["history"]), 1200)
        self.assertLess(payload["history"][0]["date"], payload["rangeStart"])
        self.assertGreaterEqual(payload["history"][1]["date"], payload["rangeStart"])
        self.assertIsNotNone(payload["history"][-1]["adjustedClose"])
        self.assertEqual(fetch_history.call_args.args[2:], ("10y", "1d", "10y"))

    def test_three_year_range_has_buffer_actions_and_reliable_metadata(self):
        today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
        expected_start = today - pd.DateOffset(years=3)
        index = pd.date_range(
            today - pd.DateOffset(years=4),
            today - pd.Timedelta(days=1),
            freq="B",
        )
        values = np.linspace(50.0, 150.0, len(index))
        frame = pd.DataFrame(
            {
                "Open": values - 0.5,
                "High": values + 1.0,
                "Low": values - 1.0,
                "Close": values,
                "Adj Close": values * 0.97,
                "Volume": np.full(len(index), 750_000.0),
                "Dividends": np.zeros(len(index)),
                "Stock Splits": np.zeros(len(index)),
            },
            index=index,
        )
        invalid_ohlc_date = index[-30]
        missing_adjusted_date = index[-40]
        invalid_optional_date = index[-50]
        dividend_date = index[-60]
        split_date = index[-70]
        frame.loc[invalid_ohlc_date, "Open"] = np.inf
        frame.loc[missing_adjusted_date, "Adj Close"] = np.nan
        frame.loc[invalid_optional_date, ["Volume", "Dividends", "Stock Splits"]] = [
            np.inf,
            np.inf,
            np.nan,
        ]
        frame.loc[dividend_date, "Dividends"] = 0.42
        frame.loc[split_date, "Stock Splits"] = 4.0

        eligible = frame.loc[frame.index >= expected_start]
        valid_mask = np.isfinite(
            eligible[["Open", "High", "Low", "Close"]].to_numpy()
        ).all(axis=1)
        expected_observations = eligible.loc[valid_mask]
        expected_adjusted_count = int(
            np.isfinite(expected_observations["Adj Close"].to_numpy()).sum()
        )

        app_module.history_cache.clear()
        with (
            patch.object(app_module, "ticker_candidates", return_value=["RESOLVED"]),
            patch.object(app_module.yf, "Ticker"),
            patch.object(
                app_module,
                "_fetch_interval_history",
                return_value=frame,
            ) as fetch_history,
        ):
            response = app_module.app.test_client().get(
                "/stock/requested/history?timeframe=1d&range=3y"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        observations = (
            payload["history"][1:]
            if payload["includesPreviousClose"]
            else payload["history"]
        )
        rows_by_date = {row["date"]: row for row in observations}

        self.assertEqual(payload["range"], "3y")
        self.assertEqual(payload["rangeStart"], expected_start.date().isoformat())
        self.assertEqual(fetch_history.call_args.args[2:], ("5y", "1d", "5y"))
        self.assertTrue(payload["includesPreviousClose"])
        self.assertEqual(payload["requestedTicker"], "REQUESTED")
        self.assertEqual(payload["resolvedTicker"], "RESOLVED")
        self.assertEqual(payload["dataSource"], "Yahoo Finance")
        self.assertTrue(payload["generatedAt"].endswith("Z"))
        self.assertIsNotNone(pd.Timestamp(payload["generatedAt"]).tzinfo)
        self.assertEqual(payload["observationCount"], len(expected_observations))
        self.assertEqual(payload["observationCount"], len(observations))
        self.assertEqual(
            payload["actualStart"],
            expected_observations.index[0].date().isoformat(),
        )
        self.assertEqual(
            payload["actualEnd"],
            expected_observations.index[-1].date().isoformat(),
        )
        self.assertEqual(payload["adjustedCloseCount"], expected_adjusted_count)
        self.assertEqual(
            payload["adjustedCloseCoveragePct"],
            round(expected_adjusted_count / len(expected_observations) * 100, 2),
        )
        self.assertEqual(payload["corporateActionCount"], 2)
        self.assertEqual(payload["invalidRowsRemoved"], 1)
        self.assertEqual(
            rows_by_date[dividend_date.date().isoformat()]["dividend"],
            0.42,
        )
        self.assertEqual(
            rows_by_date[split_date.date().isoformat()]["stockSplit"],
            4.0,
        )
        optional_row = rows_by_date[invalid_optional_date.date().isoformat()]
        self.assertEqual(optional_row["volume"], 0.0)
        self.assertEqual(optional_row["dividend"], 0.0)
        self.assertEqual(optional_row["stockSplit"], 0.0)
        self.assertTrue(any(key.startswith("v5:") for key in app_module.history_cache))

    def test_legacy_daily_history_shape_remains_available_without_range(self):
        index = pd.to_datetime(["2026-07-21", "2026-07-22", "2026-07-23"])
        frame = pd.DataFrame(
            {
                "Open": [100.0, 101.0, 102.0],
                "High": [102.0, 103.0, 104.0],
                "Low": [99.0, 100.0, 101.0],
                "Close": [101.125, 102.25, 103.375],
            },
            index=index,
        )

        app_module.history_cache.clear()
        with (
            patch.object(app_module, "ticker_candidates", return_value=["LEGACY"]),
            patch.object(app_module.yf, "Ticker"),
            patch.object(
                app_module,
                "_fetch_interval_history",
                return_value=frame,
            ) as fetch_history,
            patch.object(
                app_module,
                "_fetch_latest_daily_market_data",
                return_value=(frame, {}),
            ),
        ):
            response = app_module.app.test_client().get(
                "/stock/legacy/history?timeframe=1d"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        first_row = payload["history"][0]
        self.assertEqual(fetch_history.call_args.args[2:], ("6mo", "1d", "1y"))
        self.assertEqual(payload["range"], "default")
        self.assertIsNone(payload["rangeStart"])
        self.assertIsNone(payload["rangeEnd"])
        self.assertFalse(payload["includesPreviousClose"])
        self.assertFalse(payload["excludedPotentiallyIncompleteSession"])
        self.assertEqual(payload["observationCount"], 3)
        self.assertEqual(payload["actualStart"], "2026-07-21")
        self.assertEqual(payload["actualEnd"], "2026-07-23")
        self.assertEqual(payload["adjustedCloseCount"], 0)
        self.assertEqual(payload["adjustedCloseCoveragePct"], 0.0)
        self.assertEqual(payload["corporateActionCount"], 0)
        self.assertEqual(payload["requestedTicker"], "LEGACY")
        self.assertEqual(payload["resolvedTicker"], "LEGACY")
        self.assertEqual(first_row["date"], "2026-07-21")
        self.assertEqual(first_row["open"], 100.0)
        self.assertEqual(first_row["high"], 102.0)
        self.assertEqual(first_row["low"], 99.0)
        self.assertEqual(first_row["close"], 101.12)
        self.assertEqual(first_row["rawClose"], 101.125)
        self.assertIsNone(first_row["adjustedClose"])
        self.assertEqual(first_row["volume"], 0.0)
        self.assertEqual(first_row["dividend"], 0.0)
        self.assertEqual(first_row["stockSplit"], 0.0)

    def test_chart_fallback_preserves_adjusted_close_volume_and_actions(self):
        timestamps = [
            int(pd.Timestamp("2026-07-22 13:30:00", tz="UTC").timestamp()),
            int(pd.Timestamp("2026-07-23 13:30:00", tz="UTC").timestamp()),
        ]
        chart_payload = {
            "chart": {
                "result": [
                    {
                        "timestamp": timestamps,
                        "meta": {"symbol": "FALLBACK"},
                        "indicators": {
                            "quote": [
                                {
                                    "open": [100.0, 51.0],
                                    "high": [102.0, 53.0],
                                    "low": [99.0, 50.0],
                                    "close": [101.0, 52.0],
                                    "volume": [1000, 2000],
                                }
                            ],
                            "adjclose": [{"adjclose": [50.5, 52.0]}],
                        },
                        "events": {
                            "dividends": {
                                str(timestamps[0]): {
                                    "date": timestamps[0],
                                    "amount": 0.25,
                                }
                            },
                            "splits": {
                                str(timestamps[1]): {
                                    "date": timestamps[1],
                                    "numerator": 2.0,
                                    "denominator": 1.0,
                                    "splitRatio": "2:1",
                                }
                            },
                        },
                    }
                ]
            }
        }
        mocked_response = MagicMock()
        mocked_response.status = 200
        mocked_response.read.return_value = json.dumps(chart_payload).encode("utf-8")
        mocked_response.__enter__.return_value = mocked_response

        with patch.object(
            app_module.urllib.request,
            "urlopen",
            return_value=mocked_response,
        ):
            frame, metadata = app_module._fetch_chart_data(
                "FALLBACK",
                "5y",
                "1d",
                auto_adjust=False,
            )

        self.assertEqual(metadata["symbol"], "FALLBACK")
        self.assertEqual(frame["Volume"].tolist(), [1000.0, 2000.0])
        self.assertEqual(frame["Adj Close"].tolist(), [50.5, 52.0])
        self.assertEqual(frame["Dividends"].tolist(), [0.25, 0.0])
        self.assertEqual(frame["Stock Splits"].tolist(), [0.0, 2.0])

    def test_incomplete_and_non_finite_candles_are_removed(self):
        index = pd.to_datetime(["2026-07-23", "2026-07-24", "2026-07-25"])
        frame = pd.DataFrame(
            {
                "Open": [310.0, 320.0, np.inf],
                "High": [321.0, 323.0, 330.0],
                "Low": [305.0, 306.0, 300.0],
                "Close": [319.69, np.nan, 325.0],
                "Volume": [100, 200, 300],
            },
            index=index,
        )

        cleaned = _prepare_ohlc_df(frame, require_complete=True)

        self.assertEqual(list(cleaned.index), [index[0]])
        self.assertTrue(
            np.isfinite(cleaned[["Open", "High", "Low", "Close"]].to_numpy()).all()
        )

    def test_json_safe_produces_strict_json(self):
        payload = _json_safe(
            {
                "valid": np.float64(12.5),
                "nan": np.nan,
                "positiveInfinity": np.inf,
                "negativeInfinity": -np.inf,
            }
        )

        encoded = json.dumps(payload, allow_nan=False)
        decoded = json.loads(encoded)

        self.assertEqual(decoded["valid"], 12.5)
        self.assertIsNone(decoded["nan"])
        self.assertIsNone(decoded["positiveInfinity"])
        self.assertIsNone(decoded["negativeInfinity"])

    def test_four_hour_bars_do_not_mix_trading_sessions(self):
        first_session = pd.date_range("2026-07-23 09:30", periods=7, freq="h")
        second_session = pd.date_range("2026-07-24 09:30", periods=7, freq="h")
        index = first_session.append(second_session)
        values = np.arange(1, len(index) + 1, dtype="float64")
        frame = pd.DataFrame(
            {
                "Open": values,
                "High": values + 1,
                "Low": values - 1,
                "Close": values + 0.5,
                "Volume": np.ones(len(index)),
            },
            index=index,
        )

        resampled = _resample_ohlc_by_bar_count(frame, bars_per_bucket=4)

        self.assertEqual(len(resampled), 4)
        self.assertEqual(
            [timestamp.date().isoformat() for timestamp in resampled.index],
            ["2026-07-23", "2026-07-23", "2026-07-24", "2026-07-24"],
        )
        self.assertEqual(resampled.iloc[0]["Open"], 1.0)
        self.assertEqual(resampled.iloc[0]["Close"], 4.5)

    def test_newer_market_snapshot_becomes_last_available_day(self):
        history = pd.DataFrame(
            {
                "Open": [341.0],
                "High": [342.11],
                "Low": [315.73],
                "Close": [319.69],
                "Volume": [115_606_414],
            },
            index=pd.to_datetime(["2026-07-23"]),
        )
        market_timestamp = int(
            pd.Timestamp("2026-07-24 20:00:00", tz="UTC").timestamp()
        )
        meta = {
            "regularMarketTime": market_timestamp,
            "regularMarketPrice": 313.03,
            "regularMarketOpen": 320.72,
            "regularMarketDayHigh": 322.96,
            "regularMarketDayLow": 306.51,
            "regularMarketVolume": 62_760_000,
            "exchangeTimezoneName": "America/New_York",
            "currentTradingPeriod": {
                "regular": {
                    "start": market_timestamp - 23_400,
                    "end": market_timestamp,
                }
            },
        }

        merged = _merge_daily_market_data(history, _market_snapshot_frame(meta))
        details = _price_metadata(merged, meta)

        self.assertEqual(merged.index[-1].strftime("%Y-%m-%d"), "2026-07-24")
        self.assertAlmostEqual(details["currentPrice"], 313.03)
        self.assertAlmostEqual(details["previousClose"], 319.69)
        self.assertEqual(details["dailyChange"], -2.08)
        self.assertEqual(details["priceDate"], "2026-07-24")
        self.assertEqual(details["priceSource"], "market")

    def test_invalid_market_price_cannot_replace_valid_history(self):
        history = pd.DataFrame(
            {
                "Open": [100.0, 101.0],
                "High": [102.0, 104.0],
                "Low": [99.0, 100.0],
                "Close": [101.0, 103.0],
                "Volume": [10, 20],
            },
            index=pd.to_datetime(["2026-07-23", "2026-07-24"]),
        )
        meta = {
            "regularMarketTime": int(
                pd.Timestamp("2026-07-25 20:00:00", tz="UTC").timestamp()
            ),
            "regularMarketPrice": 0,
        }

        merged = _merge_daily_market_data(history, _market_snapshot_frame(meta))
        details = _price_metadata(merged, meta)

        self.assertEqual(len(merged), 2)
        self.assertEqual(details["currentPrice"], 103.0)
        self.assertEqual(details["priceDate"], "2026-07-24")
        self.assertEqual(details["priceSource"], "history")


if __name__ == "__main__":
    unittest.main()
