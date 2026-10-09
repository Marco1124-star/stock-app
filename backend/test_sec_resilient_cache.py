from datetime import datetime, timedelta
import unittest

from app import (
    SEC_COMPANYFACTS_CACHE_TTL,
    SEC_NEGATIVE_CACHE_TTL,
    _cache_get_adaptive,
)


class SecResilientCacheTests(unittest.TestCase):
    def test_negative_payload_expires_before_a_successful_payload(self):
        age = SEC_NEGATIVE_CACHE_TTL + timedelta(seconds=1)
        cache = {
            "negative": ({}, datetime.utcnow() - age),
            "positive": ({"facts": {"us-gaap": {}}}, datetime.utcnow() - age),
        }

        self.assertIsNone(
            _cache_get_adaptive(
                cache,
                "negative",
                SEC_COMPANYFACTS_CACHE_TTL,
            )
        )
        self.assertNotIn("negative", cache)
        self.assertEqual(
            _cache_get_adaptive(
                cache,
                "positive",
                SEC_COMPANYFACTS_CACHE_TTL,
            ),
            {"facts": {"us-gaap": {}}},
        )

    def test_negative_cik_marker_uses_the_short_ttl(self):
        cache = {
            "ticker": (
                {"cik": None},
                datetime.utcnow() - SEC_NEGATIVE_CACHE_TTL - timedelta(seconds=1),
            )
        }

        self.assertIsNone(
            _cache_get_adaptive(
                cache,
                "ticker",
                timedelta(hours=24),
                is_negative=lambda value: value.get("cik") is None,
            )
        )
        self.assertNotIn("ticker", cache)


if __name__ == "__main__":
    unittest.main()
