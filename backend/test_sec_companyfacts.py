import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app import (
    _extract_sec_cik_from_efts,
    _fetch_financial_timeseries,
    _fetch_financial_timeseries_sec,
    _fetch_sec_companyfacts_payload,
    _fetch_sec_filings,
    _fetch_sec_submissions_payload,
    _latest_fundamental_training_price,
    _parse_sec_submissions,
    _parse_sec_companyfacts,
    _resolve_sec_cik,
    _resolve_sec_cik_via_efts,
    _sec_request_json,
    sec_companyfacts_cache,
    sec_filings_cache,
    sec_reference_cache,
)


def fact(entries, unit="USD"):
    return {"units": {unit: entries}}


def annual(value, end, filed, *, start=None, form="10-K", fp="FY", accn="1"):
    entry = {
        "val": value,
        "end": end,
        "filed": filed,
        "form": form,
        "fp": fp,
        "accn": accn,
    }
    if start is not None:
        entry["start"] = start
    return entry


class SecCompanyFactsTests(unittest.TestCase):
    def setUp(self):
        sec_reference_cache.clear()
        sec_companyfacts_cache.clear()
        sec_filings_cache.clear()

    def test_parser_maps_deduplicates_and_derives_annual_metrics(self):
        payload = {
            "facts": {
                "us-gaap": {
                    "RevenueFromContractWithCustomerExcludingAssessedTax": fact(
                        [
                            annual(
                                100,
                                "2023-12-31",
                                "2024-02-10",
                                start="2023-01-01",
                                accn="old",
                            ),
                            # Una riclassifica nello stesso periodo deve
                            # preferire il filing più recente.
                            annual(
                                110,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                                accn="new",
                            ),
                            annual(
                                999,
                                "2024-03-31",
                                "2024-05-01",
                                start="2024-01-01",
                                form="10-Q",
                                fp="Q1",
                            ),
                        ]
                    ),
                    "CostOfRevenue": fact(
                        [
                            annual(
                                40,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "OperatingExpenses": fact(
                        [
                            annual(
                                20,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "Assets": fact(
                        [annual(500, "2023-12-31", "2025-02-10")]
                    ),
                    "LongTermDebtCurrent": fact(
                        [annual(10, "2023-12-31", "2025-02-10")]
                    ),
                    "LongTermDebtNoncurrent": fact(
                        [annual(90, "2023-12-31", "2025-02-10")]
                    ),
                    "NetCashProvidedByUsedInOperatingActivities": fact(
                        [
                            annual(
                                60,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "PaymentsToAcquirePropertyPlantAndEquipment": fact(
                        [
                            annual(
                                15,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "PaymentsToAcquireBusinessesNetOfCashAcquired": fact(
                        [
                            annual(
                                12,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "ProceedsFromIssuanceOfCommonStock": fact(
                        [
                            annual(
                                7,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ]
                    ),
                    "EarningsPerShareDiluted": fact(
                        [
                            annual(
                                2.5,
                                "2023-12-31",
                                "2025-02-10",
                                start="2023-01-01",
                            )
                        ],
                        unit="USD/shares",
                    ),
                }
            }
        }

        result = _parse_sec_companyfacts(payload)

        self.assertEqual(result["TotalRevenue"]["2023-12-31"], 110)
        self.assertNotIn("2024-03-31", result["TotalRevenue"])
        self.assertEqual(result["GrossProfit"]["2023-12-31"], 70)
        self.assertEqual(result["OperatingIncome"]["2023-12-31"], 50)
        self.assertEqual(result["TotalAssets"]["2023-12-31"], 500)
        self.assertEqual(result["TotalDebt"]["2023-12-31"], 100)
        self.assertEqual(result["CapitalExpenditure"]["2023-12-31"], -15)
        self.assertEqual(result["PurchaseOfBusiness"]["2023-12-31"], -12)
        self.assertEqual(result["IssuanceOfCapitalStock"]["2023-12-31"], 7)
        self.assertEqual(result["FreeCashFlow"]["2023-12-31"], 45)
        self.assertEqual(result["DilutedEPS"]["2023-12-31"], 2.5)

    def test_parser_keeps_only_the_latest_ten_fiscal_years(self):
        revenue_entries = [
            annual(
                year,
                f"{year}-12-31",
                f"{year + 1}-02-10",
                start=f"{year}-01-01",
            )
            for year in range(2013, 2026)
        ]
        payload = {
            "facts": {
                "us-gaap": {
                    "Revenues": fact(revenue_entries),
                }
            }
        }

        values = _parse_sec_companyfacts(payload)["TotalRevenue"]

        self.assertEqual(len(values), 10)
        self.assertIn("2025-12-31", values)
        self.assertIn("2016-12-31", values)
        self.assertNotIn("2015-12-31", values)

    @patch("app._fetch_financial_timeseries_sec")
    @patch("app._fetch_financial_timeseries_yfinance")
    @patch("app._fetch_financial_timeseries_direct")
    def test_sec_only_fills_gaps_after_yahoo(
        self,
        direct_fetch,
        yfinance_fetch,
        sec_fetch,
    ):
        direct_fetch.return_value = (
            {"TotalRevenue": {"2025-12-31": 125}},
            {"TotalRevenue": 130},
        )
        yfinance_fetch.return_value = (
            {
                "TotalRevenue": {
                    "2025-12-31": 999,
                    "2024-12-31": 110,
                }
            },
            {"TotalRevenue": 1_000},
        )
        sec_fetch.return_value = (
            {
                "TotalRevenue": {
                    "2025-12-31": 888,
                    "2024-12-31": 777,
                    "2023-12-31": 100,
                },
                "TotalAssets": {"2023-12-31": 500},
            },
            {},
        )

        dated, trailing = _fetch_financial_timeseries("AAPL", "annual")

        self.assertEqual(dated["TotalRevenue"]["2025-12-31"], 125)
        self.assertEqual(dated["TotalRevenue"]["2024-12-31"], 110)
        self.assertEqual(dated["TotalRevenue"]["2023-12-31"], 100)
        self.assertEqual(dated["TotalAssets"]["2023-12-31"], 500)
        self.assertEqual(trailing["TotalRevenue"], 130)

    @patch("app._fetch_sec_companyfacts_payload", side_effect=TimeoutError)
    def test_sec_failure_is_non_fatal(self, _payload_fetch):
        self.assertEqual(
            _fetch_financial_timeseries_sec("AAPL", "annual"),
            ({}, {}),
        )
        self.assertEqual(
            _fetch_financial_timeseries_sec("AAPL", "quarterly"),
            ({}, {}),
        )

    @patch("app._sec_request_json")
    def test_ticker_and_companyfacts_requests_are_cached(self, request_json):
        companyfacts = {"facts": {"us-gaap": {}}}
        request_json.side_effect = [
            {
                "0": {
                    "cik_str": 320193,
                    "ticker": "AAPL",
                    "title": "Apple Inc.",
                }
            },
            companyfacts,
        ]

        first = _fetch_sec_companyfacts_payload("AAPL")
        second = _fetch_sec_companyfacts_payload("AAPL")

        self.assertIs(first, companyfacts)
        self.assertIs(second, companyfacts)
        self.assertEqual(request_json.call_count, 2)
        self.assertIn(
            "CIK0000320193.json",
            request_json.call_args_list[1].args[0],
        )

    def test_training_cache_is_an_explicit_offline_fallback(self):
        companyfacts = {"cik": 320193, "facts": {"us-gaap": {}}}
        submissions = {"cik": "320193", "name": "Apple Inc."}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            issuer = root / "sec" / "0000320193"
            prices = root / "prices"
            issuer.mkdir(parents=True)
            prices.mkdir(parents=True)
            (root / "company_tickers.json").write_text(
                json.dumps(
                    {
                        "0": {
                            "cik_str": 320193,
                            "ticker": "AAPL",
                            "title": "Apple Inc.",
                        }
                    }
                ),
                encoding="utf-8",
            )
            (issuer / "companyfacts.json").write_text(
                json.dumps(companyfacts),
                encoding="utf-8",
            )
            (issuer / "submissions.json").write_text(
                json.dumps(submissions),
                encoding="utf-8",
            )
            (prices / "AAPL.csv").write_text(
                "Date,Close\n2026-07-24,210.0\n2026-07-27,212.5\n",
                encoding="utf-8",
            )

            with (
                patch("app.FUNDAMENTAL_TRAINING_CACHE_DIR", str(root)),
                patch("app._sec_request_json", side_effect=TimeoutError),
            ):
                self.assertEqual(
                    _fetch_sec_companyfacts_payload("AAPL"),
                    companyfacts,
                )
                self.assertEqual(
                    _fetch_sec_submissions_payload("AAPL"),
                    submissions,
                )
                self.assertEqual(
                    _latest_fundamental_training_price("AAPL"),
                    (212.5, "2026-07-27"),
                )

    def test_efts_parser_requires_exact_ticker_inside_parentheses(self):
        payload = {
            "hits": {
                "hits": [
                    {
                        "_source": {
                            "display_names": [
                                "AAPL Research Holdings  (CIK 0000000001)",
                                "Other Corp  (AAPLX)  (CIK 0000000002)",
                            ]
                        }
                    }
                ]
            },
            "aggregations": {
                "entity_filter": {
                    "buckets": [
                        {
                            "key": (
                                "APPLE INC  (AAPL)  "
                                "(CIK 0000320193)"
                            )
                        }
                    ]
                }
            },
        }

        self.assertEqual(
            _extract_sec_cik_from_efts(payload, "aapl"),
            320193,
        )

    def test_efts_parser_does_not_accept_mentions_or_partial_tickers(self):
        payload = {
            "hits": {
                "hits": [
                    {
                        "_source": {
                            "display_names": [
                                "AAPL Analytics Inc  (CIK 0000000001)",
                                "Example  (AAPLX)  (CIK 0000000002)",
                                (
                                    "Example Bank  (MS, AAPL-P)  "
                                    "(CIK 0000000003)"
                                ),
                            ]
                        }
                    }
                ]
            }
        }

        self.assertIsNone(
            _extract_sec_cik_from_efts(payload, "AAPL"),
        )

    @patch("app._sec_ticker_lookup", return_value={})
    @patch("app._resolve_sec_cik_from_training_cache", return_value=None)
    @patch("app._sec_request_json")
    def test_efts_resolves_and_caches_cik_when_primary_index_is_empty(
        self,
        request_json,
        _training_cache,
        _ticker_lookup,
    ):
        request_json.return_value = {
            "hits": {
                "hits": [
                    {
                        "_source": {
                            "display_names": [
                                "APPLE INC  (AAPL)  (CIK 0000320193)"
                            ]
                        }
                    }
                ]
            }
        }

        self.assertEqual(_resolve_sec_cik("AAPL"), 320193)
        self.assertEqual(_resolve_sec_cik("AAPL"), 320193)

        request_json.assert_called_once()
        requested_url = request_json.call_args.args[0]
        self.assertIn("https://efts.sec.gov/LATEST/search-index?", requested_url)
        self.assertIn("q=AAPL", requested_url)

    @patch("app._sec_request_json", side_effect=TimeoutError)
    def test_efts_error_and_negative_result_are_non_fatal_and_cached(
        self,
        request_json,
    ):
        self.assertIsNone(_resolve_sec_cik_via_efts("MISSING"))
        self.assertIsNone(_resolve_sec_cik_via_efts("MISSING"))
        request_json.assert_called_once()

    @patch("app.urllib.request.urlopen")
    def test_sec_request_uses_configured_user_agent_and_timeout(self, urlopen):
        response = MagicMock()
        response.read.return_value = b"{}"
        response.headers.get.return_value = None
        urlopen.return_value.__enter__.return_value = response

        with patch.dict(
            os.environ,
            {"SEC_USER_AGENT": "StockApp test contact@example.com"},
        ):
            self.assertEqual(_sec_request_json("https://data.sec.gov/test", 7), {})

        request_object = urlopen.call_args.args[0]
        self.assertEqual(
            request_object.get_header("User-agent"),
            "StockApp test contact@example.com",
        )
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 7)

    def test_submissions_parser_builds_safe_official_filing_links(self):
        payload = {
            "cik": "320193",
            "name": "Apple Inc.",
            "filings": {
                "recent": {
                    "form": ["8-K", "10-Q", "10-K", "S-8"],
                    "accessionNumber": [
                        "0000320193-26-000010",
                        "0000320193-26-000009",
                        "0000320193-25-000100",
                        "0000320193-25-000099",
                    ],
                    "filingDate": [
                        "2026-05-01",
                        "2026-04-30",
                        "2025-10-31",
                        "2025-10-30",
                    ],
                    "reportDate": [
                        "2026-04-30",
                        "2026-03-28",
                        "2025-09-27",
                        "",
                    ],
                    "acceptanceDateTime": [
                        "20260501170000",
                        "20260430170000",
                        "20251031170000",
                        "20251030170000",
                    ],
                    "primaryDocument": [
                        "aapl-20260501.htm",
                        "aapl-20260328.htm",
                        "aapl-20250927.htm",
                        "ignored.htm",
                    ],
                    "primaryDocDescription": [
                        "Current report",
                        "Quarterly report",
                        "Annual report",
                        "Registration statement",
                    ],
                }
            },
        }

        result = _parse_sec_submissions(payload)

        self.assertTrue(result["available"])
        self.assertEqual(result["cik"], "0000320193")
        self.assertEqual(len(result["items"]), 3)
        annual = next(item for item in result["items"] if item["form"] == "10-K")
        self.assertEqual(annual["category"], "annual")
        self.assertIn(
            "/Archives/edgar/data/320193/000032019325000100/",
            annual["filingUrl"],
        )
        self.assertTrue(annual["documentUrl"].endswith("aapl-20250927.htm"))
        self.assertTrue(result["companyUrl"].startswith("https://www.sec.gov/"))

    @patch("app._resolve_sec_cik", return_value=320193)
    @patch("app._sec_request_json")
    def test_official_filings_are_cached(
        self,
        request_json,
        _resolve_cik,
    ):
        request_json.return_value = {
            "cik": 320193,
            "name": "Apple Inc.",
            "filings": {"recent": {}},
        }

        first = _fetch_sec_filings("AAPL")
        second = _fetch_sec_filings("AAPL")

        self.assertIs(first, second)
        request_json.assert_called_once()
        self.assertIn(
            "submissions/CIK0000320193.json",
            request_json.call_args.args[0],
        )
        self.assertEqual(request_json.call_args.kwargs["timeout"], 8)


if __name__ == "__main__":
    unittest.main()
