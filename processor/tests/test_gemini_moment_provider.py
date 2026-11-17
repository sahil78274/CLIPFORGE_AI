"""Offline checks for Gemini moment scoring request authentication."""
import json
import unittest
from unittest import mock

from processor.clip_detection import moment_detector


class FakeGeminiResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class GeminiMomentProviderTests(unittest.TestCase):
    def test_generate_content_uses_header_auth_and_keeps_key_out_of_url(self):
        fake_key = "fake-gemini-key-for-tests-only"
        moments = [
            {
                "startSec": 1.0,
                "endSec": 8.0,
                "title": "Test moment",
                "category": "insight",
                "reason": "Test output",
                "engagementScore": 80,
            }
        ]
        response = FakeGeminiResponse(
            {
                "candidates": [
                    {"content": {"parts": [{"text": json.dumps({"moments": moments})}]}}
                ]
            }
        )
        with mock.patch.object(
            moment_detector.urllib.request, "urlopen", return_value=response
        ) as urlopen:
            result = moment_detector._try_gemini_moment_scoring(
                segments=[{"start": 1.0, "end": 8.0, "text": "A validated test transcript."}],
                gemini_api_key=fake_key,
                gemini_model="gemini-test-model",
                min_dur=5.0,
                max_dur=10.0,
                clip_count=1,
            )

        request = urlopen.call_args.args[0]
        self.assertEqual(result, moments)
        self.assertNotIn("key=", request.full_url)
        self.assertEqual(request.get_header("X-goog-api-key"), fake_key)
        self.assertEqual(request.get_method(), "POST")


if __name__ == "__main__":
    unittest.main()
