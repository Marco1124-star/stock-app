import unittest
from unittest.mock import patch

from app import (
    _align_sec_periods_to_yahoo,
    _fetch_financial_timeseries,
    _merge_financial_timeseries,
    _serialize_financial_statements,
)


class FinancialsPipelineTests(unittest.TestCase):
    def test_merge_completes_missing_values_without_overwriting_direct_source(self):
        direct_dated = {
            "TotalRevenue": {
                "2025-12-31": 125.0,
            },
            "OperatingIncome": {
                "2025-12-31": 25.0,
            },
        }
        fallback_dated = {
            "TotalRevenue": {
                "2025-12-31": 999.0,
                "2024-12-31": 110.0,
            },
            "NetIncome": {
                "2025-12-31": 18.0,
            },
        }

        dated, trailing = _merge_financial_timeseries(
            direct_dated,
            {"TotalRevenue": 130.0},
            fallback_dated,
            {"TotalRevenue": 1_000.0, "NetIncome": 19.0},
        )

        self.assertEqual(dated["TotalRevenue"]["2025-12-31"], 125.0)
        self.assertEqual(dated["TotalRevenue"]["2024-12-31"], 110.0)
        self.assertEqual(dated["NetIncome"]["2025-12-31"], 18.0)
        self.assertEqual(trailing["TotalRevenue"], 130.0)
        self.assertEqual(trailing["NetIncome"], 19.0)

    @patch("app._fetch_financial_timeseries_sec")
    @patch("app._fetch_financial_timeseries_yfinance")
    @patch("app._fetch_financial_timeseries_direct")
    def test_partial_direct_response_is_enriched_by_yfinance(
        self,
        direct_fetch,
        fallback_fetch,
        sec_fetch,
    ):
        direct_fetch.return_value = (
            {"TotalRevenue": {"2025-12-31": 125.0}},
            {},
        )
        fallback_fetch.return_value = (
            {
                "TotalRevenue": {
                    "2025-12-31": 999.0,
                    "2024-12-31": 110.0,
                },
                "OperatingIncome": {"2025-12-31": 25.0},
            },
            {},
        )
        sec_fetch.return_value = ({}, {})

        dated, _ = _fetch_financial_timeseries("TEST", "annual")

        direct_fetch.assert_called_once_with("TEST", "annual")
        fallback_fetch.assert_called_once_with("TEST", "annual")
        sec_fetch.assert_called_once_with("TEST", "annual")
        self.assertEqual(dated["TotalRevenue"]["2025-12-31"], 125.0)
        self.assertEqual(dated["TotalRevenue"]["2024-12-31"], 110.0)
        self.assertEqual(dated["OperatingIncome"]["2025-12-31"], 25.0)

    def test_sec_period_is_aligned_to_nearby_yahoo_fiscal_date(self):
        yahoo = {
            "TotalRevenue": {"2025-09-30": 125.0},
        }
        sec = {
            "TotalRevenue": {"2025-09-27": 999.0},
            "TotalAssets": {
                "2025-09-27": 500.0,
                "2018-06-30": 300.0,
            },
        }

        aligned = _align_sec_periods_to_yahoo(yahoo, sec)
        merged, _ = _merge_financial_timeseries(
            yahoo,
            {},
            aligned,
            {},
        )
        statements = _serialize_financial_statements(merged, {}, "annual")
        period_keys = {
            period["key"]
            for statement in statements.values()
            for period in statement["periods"]
        }

        self.assertEqual(
            aligned["TotalRevenue"],
            {"2025-09-30": 999.0},
        )
        self.assertEqual(
            aligned["TotalAssets"],
            {
                "2025-09-30": 500.0,
                "2018-06-30": 300.0,
            },
        )
        self.assertEqual(merged["TotalRevenue"]["2025-09-30"], 125.0)
        self.assertIn("2025-09-30", period_keys)
        self.assertNotIn("2025-09-27", period_keys)
        self.assertIn("2018-06-30", period_keys)

    def test_sec_alignment_keeps_periods_beyond_tolerance_separate(self):
        aligned = _align_sec_periods_to_yahoo(
            {"TotalRevenue": {"2025-09-30": 125.0}},
            {"TotalAssets": {"2025-08-15": 500.0}},
        )

        self.assertEqual(
            aligned["TotalAssets"],
            {"2025-08-15": 500.0},
        )

    def test_sec_alignment_prefers_same_month_and_is_one_to_one(self):
        aligned = _align_sec_periods_to_yahoo(
            {
                "TotalRevenue": {
                    "2025-02-01": 1.0,
                    "2025-02-28": 2.0,
                }
            },
            {
                "TotalAssets": {
                    "2025-01-31": 10.0,
                    "2025-02-14": 20.0,
                }
            },
        )

        # Il matching globale conserva due esercizi distinti e assegna il
        # periodo di febbraio alla controparte Yahoo dello stesso mese.
        self.assertEqual(
            aligned["TotalAssets"],
            {
                "2025-02-01": 10.0,
                "2025-02-28": 20.0,
            },
        )

    def test_serialization_keeps_ten_annual_periods(self):
        dated_values = {
            "TotalAssets": {
                f"{year}-12-31": float(year)
                for year in range(2011, 2026)
            }
        }

        statements = _serialize_financial_statements(
            dated_values,
            {},
            "annual",
        )
        period_keys = [
            period["key"]
            for period in statements["balance"]["periods"]
        ]

        self.assertEqual(len(period_keys), 10)
        self.assertEqual(period_keys[0], "2025-12-31")
        self.assertEqual(period_keys[-1], "2016-12-31")

    def test_serialization_keeps_twelve_quarterly_periods(self):
        quarterly_dates = [
            f"{year}-{month:02d}-30"
            for year in range(2022, 2026)
            for month in (3, 6, 9, 12)
        ]
        dated_values = {
            "TotalAssets": {
                period: float(index)
                for index, period in enumerate(quarterly_dates, start=1)
            }
        }

        statements = _serialize_financial_statements(
            dated_values,
            {},
            "quarterly",
        )
        period_keys = [
            period["key"]
            for period in statements["balance"]["periods"]
        ]

        self.assertEqual(len(period_keys), 12)
        self.assertEqual(period_keys[0], "2025-12-30")
        self.assertEqual(period_keys[-1], "2023-03-30")


if __name__ == "__main__":
    unittest.main()
