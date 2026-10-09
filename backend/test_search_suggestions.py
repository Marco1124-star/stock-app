import importlib
import json
import unittest
from unittest.mock import MagicMock, patch


class SearchSuggestionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.import_module("app")

    def setUp(self):
        self.module.search_suggestions_cache.clear()
        self.client = self.module.app.test_client()

    def test_empty_and_long_queries_do_not_contact_provider(self):
        with patch.object(self.module.urllib.request, "urlopen") as get:
            self.assertEqual(self.client.get("/search/suggestions?q=").get_json(), {"suggestions": []})
            self.assertEqual(self.client.get("/search/suggestions", query_string={"q": "x" * 81}).status_code, 400)
            get.assert_not_called()

    def test_nonempty_route_returns_quotes_deduplicated_and_cached(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {}
        response.read.return_value = json.dumps({"quotes": [
            {"symbol": "ENI.MI", "shortname": "Eni S.p.A.", "exchDisp": "Milan", "quoteType": "EQUITY"},
            {"symbol": "ENI.MI", "quoteType": "EQUITY"},
            {"symbol": "OPTION1", "quoteType": "OPTION"},
            {"symbol": "E", "longname": "Eni ADR", "quoteType": "EQUITY"},
        ]}).encode()
        with patch.object(self.module.urllib.request, "urlopen", return_value=response) as get:
            for _ in range(2):
                result = self.client.get("/search/suggestions?q=Eni&limit=2")
                self.assertEqual(result.status_code, 200)
                self.assertEqual([x["symbol"] for x in result.get_json()["suggestions"]], ["ENI.MI", "E"])
            get.assert_called_once()

    def test_provider_failure_is_not_reported_as_no_matches(self):
        with patch.object(self.module.urllib.request, "urlopen", side_effect=OSError("offline")):
            response = self.client.get("/search/suggestions?q=Tesla")
            self.assertEqual(response.status_code, 502)
            self.assertIn("error", response.get_json())


if __name__ == "__main__":
    unittest.main()
