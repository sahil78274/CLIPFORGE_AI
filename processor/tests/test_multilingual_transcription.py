"""Regression tests for multilingual Whisper validation and speech-safe clip timing.

The fixtures are short transcript/audio cases; Whisper is faked so the tests stay
offline and deterministic. Real model/voice quality still depends on the configured
multilingual Faster-Whisper weights.
"""
import os
import tempfile
import unittest
import wave
from types import SimpleNamespace
from unittest import mock

from processor.transcription import transcriber
from processor.video_editor.subtitle_generator import generate_ass_subtitles
from processor.clip_detection import moment_detector
from processor.clip_detection.moment_detector import detect_candidate_moments
from processor.clip_detection.clip_selector import select_unique_clips
from processor.main import _protect_caption_word_boundaries


SAMPLE_UTTERANCES = {
    "hindi": "नमस्ते, आज हम वीडियो की सबसे ज़रूरी बात समझेंगे।",
    "english": "Today we are building a useful video clip together.",
    "hinglish": "Aaj hum AI clips create karenge, yeh bahut useful hai.",
    "arabic": "مرحباً بكم، اليوم سنتحدث عن أهم فكرة في هذا الفيديو.",
}


class FakeWord:
    def __init__(self, word, start, end, probability=0.97):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class FakeSegment:
    def __init__(self, text, start=0.1, end=2.0):
        self.text = text
        self.start = start
        self.end = end
        tokens = text.split()
        span = (end - start) / max(1, len(tokens))
        self.words = [
            FakeWord(token, start + i * span, start + (i + 1) * span)
            for i, token in enumerate(tokens)
        ]


class FakeWhisper:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def transcribe(self, wav_path, **kwargs):
        self.calls.append(kwargs)
        language, text = self.outputs.pop(0)
        info = SimpleNamespace(language=language, language_probability=0.94)
        return iter([FakeSegment(text)]), info


class MultilingualTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.wav_path = os.path.join(self.tempdir.name, "sample.wav")
        with wave.open(self.wav_path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x00" * 32000)

    def tearDown(self):
        self.tempdir.cleanup()

    def transcribe(self, outputs, language="auto", offset=0.0):
        fake = FakeWhisper(outputs)
        with mock.patch.object(transcriber, "_load_whisper_model", return_value=fake):
            result = transcriber.transcribe_chunk_media(
                wav_path=self.wav_path,
                win_start=offset,
                win_end=offset + 2.0,
                embedded_global_segments=None,
                whisper_model_size="small",
                whisper_model_path="",
                whisper_device="cpu",
                whisper_compute_type="int8",
                language=language,
            )
        return result, fake

    def test_hindi_script_conflict_retries_and_preserves_words_and_global_word_times(self):
        text = SAMPLE_UTTERANCES["hindi"]
        result, fake = self.transcribe([("ar", text), ("hi", text)], language="ar", offset=20.0)
        self.assertEqual([call["language"] for call in fake.calls], [None, "hi"])
        self.assertEqual([call["task"] for call in fake.calls], ["transcribe", "transcribe"])
        self.assertEqual(result["detectedLanguage"], "hi")
        self.assertTrue(result["languageValidated"])
        segment = result["segments"][0]
        self.assertEqual(segment["text"], text)
        self.assertTrue(segment["captionable"])
        self.assertAlmostEqual(segment["words"][0]["start"], 20.1, places=2)

    def test_english_is_auto_detected_without_forcing_or_translation(self):
        text = SAMPLE_UTTERANCES["english"]
        result, fake = self.transcribe([("en", text)])
        self.assertEqual(len(fake.calls), 1)
        self.assertIsNone(fake.calls[0]["language"])
        self.assertEqual(fake.calls[0]["task"], "transcribe")
        self.assertEqual(result["detectedLanguage"], "en")
        self.assertTrue(result["languageValidated"])
        self.assertEqual(result["segments"][0]["text"], text)

    def test_hinglish_auto_detection_preserves_mixed_words_and_script(self):
        text = SAMPLE_UTTERANCES["hinglish"]
        result, fake = self.transcribe([("en", text)])
        self.assertEqual(len(fake.calls), 1)
        self.assertIsNone(fake.calls[0]["language"])
        self.assertEqual(result["detectedLanguage"], "en")
        self.assertEqual(result["segments"][0]["text"], text)
        self.assertEqual(result["languageProfile"], "hinglish")
        self.assertTrue(result["languageValidated"])

    def test_common_english_words_do_not_trigger_a_false_hinglish_retry(self):
        text = "The new idea is to use the best clips for your channel."
        result, fake = self.transcribe([("en", text)])
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(result["detectedLanguage"], "en")
        self.assertEqual(result["languageProfile"], "en")
        self.assertTrue(result["languageValidated"])

    def test_arabic_script_conflict_retries_and_keeps_arabic_script(self):
        text = SAMPLE_UTTERANCES["arabic"]
        result, fake = self.transcribe([("en", text), ("ar", text)])
        self.assertEqual([call["language"] for call in fake.calls], [None, "ar"])
        self.assertEqual(result["detectedLanguage"], "ar")
        self.assertTrue(result["languageValidated"])
        self.assertEqual(result["segments"][0]["text"], text)

    def test_persistent_language_conflict_suppresses_caption_events(self):
        hindi_text = SAMPLE_UTTERANCES["hindi"]
        result, _ = self.transcribe([("ar", hindi_text), ("hi", SAMPLE_UTTERANCES["english"])])
        self.assertFalse(result["languageValidated"])
        self.assertFalse(result["segments"][0]["captionable"])
        ass_path = os.path.join(self.tempdir.name, "unverified.ass")
        generate_ass_subtitles(
            ass_path=ass_path,
            play_w=720,
            play_h=1280,
            clip_start=0.0,
            clip_end=2.0,
            segments=result["segments"],
            caption_style={"enabled": True},
            watermark_enabled=False,
            watermark_text="",
            intro_text="",
            outro_text="",
        )
        with open(ass_path, encoding="utf-8") as ass_file:
            self.assertNotIn("Dialogue: 1,", ass_file.read())

    def test_unverified_embedded_subtitles_are_not_burned_when_whisper_is_unavailable(self):
        embedded = [
            {
                "id": 0,
                "start": 0.0,
                "end": 2.0,
                "text": SAMPLE_UTTERANCES["hindi"],
                "words": [],
            }
        ]
        with mock.patch.object(transcriber, "_load_whisper_model", return_value=None):
            result = transcriber.transcribe_chunk_media(
                wav_path=self.wav_path,
                win_start=0.0,
                win_end=2.0,
                embedded_global_segments=embedded,
                whisper_model_size="small",
                whisper_model_path="",
                whisper_device="cpu",
                whisper_compute_type="int8",
                language="auto",
            )
        self.assertEqual(result["detectedLanguage"], "und")
        self.assertFalse(result["segments"][0]["captionable"])
        ass_path = os.path.join(self.tempdir.name, "unverified-embedded.ass")
        generate_ass_subtitles(
            ass_path=ass_path,
            play_w=720,
            play_h=1280,
            clip_start=0.0,
            clip_end=2.0,
            segments=result["segments"],
            caption_style={"enabled": True},
            watermark_enabled=False,
            watermark_text="",
            intro_text="",
            outro_text="",
        )
        with open(ass_path, encoding="utf-8") as ass_file:
            self.assertNotIn("Dialogue: 1,", ass_file.read())

    def test_caption_output_keeps_script_and_whisper_word_timing(self):
        text = SAMPLE_UTTERANCES["arabic"]
        result, _ = self.transcribe([("ar", text)], offset=10.0)
        ass_path = os.path.join(self.tempdir.name, "arabic.ass")
        generate_ass_subtitles(
            ass_path=ass_path,
            play_w=720,
            play_h=1280,
            clip_start=10.0,
            clip_end=12.0,
            segments=result["segments"],
            caption_style={"enabled": True, "animation": "word_pop"},
            watermark_enabled=False,
            watermark_text="",
            intro_text="",
            outro_text="",
        )
        with open(ass_path, encoding="utf-8") as ass_file:
            ass = ass_file.read()
        self.assertIn("مرحباً", ass)
        self.assertIn("Noto Sans", ass)
        self.assertIn("Dialogue: 1,", ass)

    def test_multilingual_profile_is_not_flattened_to_the_last_detected_language(self):
        summary = transcriber.summarize_detected_language(
            [
                {
                    "text": "Welcome to the channel.",
                    "language": "en",
                    "languageProfile": "en",
                    "languageValidated": True,
                },
                {
                    "text": "مرحباً بكم في القناة today.",
                    "language": "ar",
                    "languageProfile": "multilingual",
                    "languageValidated": True,
                },
            ]
        )
        self.assertEqual(summary, "multilingual")


class SpeechSafeHighlightTests(unittest.TestCase):
    def test_dead_air_trim_cannot_remove_verified_first_or_last_words(self):
        segments = [
            {
                "start": 10.0,
                "end": 20.0,
                "captionable": True,
                "languageValidated": True,
                "words": [
                    {"word": "First", "start": 10.2, "end": 10.5},
                    {"word": "last.", "start": 19.5, "end": 19.8},
                ],
            }
        ]
        safe_start, safe_end = _protect_caption_word_boundaries(
            clip_start=10.3,
            clip_end=19.6,
            candidate_start=10.0,
            candidate_end=20.0,
            segments=segments,
            duration_sec=30.0,
        )
        self.assertLess(safe_start, 10.2)
        self.assertGreater(safe_end, 19.8)

    def test_hindi_and_arabic_punctuation_are_sentence_boundaries(self):
        self.assertTrue(moment_detector._ends_sentence("यह एक पूरा वाक्य है।"))
        self.assertTrue(moment_detector._ends_sentence("هل هذا واضح؟"))
        self.assertTrue(moment_detector._ends_sentence("یہ ایک مکمل جملہ ہے۔"))

    def test_overlong_asr_segment_splits_at_whisper_sentence_word_boundaries(self):
        sentences = [
            "This is the first complete sentence.",
            "This is the second complete sentence.",
            "And this is the final complete sentence.",
        ]
        words = []
        cursor = 0.0
        for sentence in sentences:
            tokens = sentence.split()
            for token in tokens:
                words.append({"word": token, "start": cursor, "end": cursor + 2.0})
                cursor += 2.0
        split = moment_detector._split_long_segments_for_moments(
            [
                {
                    "id": 0,
                    "start": 0.0,
                    "end": cursor,
                    "text": " ".join(sentences),
                    "words": words,
                    "languageValidated": True,
                }
            ],
            max_dur=15.0,
        )
        self.assertEqual(len(split), 3)
        self.assertTrue(all(segment["end"] - segment["start"] <= 15.0 for segment in split))
        self.assertTrue(all(segment["text"].endswith(".") for segment in split))

    def test_candidate_detection_uses_word_boundary_splits_for_overlong_asr_segments(self):
        sentences = [
            "This is the first complete sentence.",
            "This is the second complete sentence.",
            "And this is the final complete sentence.",
        ]
        words = []
        cursor = 0.0
        for sentence in sentences:
            for token in sentence.split():
                words.append({"word": token, "start": cursor, "end": cursor + 1.2})
                cursor += 1.2
        result = detect_candidate_moments(
            segments=[
                {
                    "id": 0,
                    "start": 0.0,
                    "end": cursor,
                    "text": " ".join(sentences),
                    "words": words,
                    "languageValidated": True,
                }
            ],
            scenes=[],
            energy_timeline=[],
            duration_sec=cursor,
            min_dur=4.0,
            max_dur=8.0,
            clip_count=1,
        )
        candidates = result["candidates"]
        self.assertGreaterEqual(len(candidates), 3)
        self.assertTrue(all(candidate["durationSec"] <= 8.0 * 1.35 for candidate in candidates))
        self.assertTrue(any(candidate["transcript"].endswith("first complete sentence.") for candidate in candidates))
        self.assertTrue(any(candidate["transcript"].endswith("second complete sentence.") for candidate in candidates))

    def test_ai_moment_expands_to_complete_word_and_segment_boundaries(self):
        segments = [
            {
                "start": 10.0,
                "end": 13.0,
                "text": "Here is the complete first part.",
                "languageValidated": True,
                "words": [{"word": "Here", "start": 10.2, "end": 10.6}],
            },
            {
                "start": 13.3,
                "end": 19.5,
                "text": "And this is the final complete sentence.",
                "languageValidated": True,
                "words": [{"word": "sentence.", "start": 18.9, "end": 19.4}],
            },
        ]
        with mock.patch(
            "processor.clip_detection.moment_detector._try_gemini_moment_scoring",
            return_value=[{"startSec": 10.5, "endSec": 18.7, "title": "Complete thought"}],
        ):
            result = detect_candidate_moments(
                segments=segments,
                scenes=[],
                energy_timeline=[],
                duration_sec=40,
                min_dur=5,
                max_dur=20,
                clip_count=1,
            )
        ai_candidate = next(c for c in result["candidates"] if c["title"] == "Complete thought")
        self.assertLess(ai_candidate["startSec"], 10.0)
        self.assertGreater(ai_candidate["endSec"], 19.5)
        self.assertIn("complete first part", ai_candidate["transcript"])
        self.assertIn("final complete sentence", ai_candidate["transcript"])

    def test_selector_uses_transcript_boundaries_for_missing_slots(self):
        segments = [
            {
                "start": 2.0,
                "end": 11.0,
                "text": "The first complete sentence ends here.",
                "languageValidated": True,
                "words": [{"word": "here.", "start": 10.5, "end": 10.9}],
            },
            {
                "start": 11.4,
                "end": 22.0,
                "text": "The next sentence finishes with a useful conclusion.",
                "languageValidated": True,
                "words": [{"word": "conclusion.", "start": 21.4, "end": 21.9}],
            },
        ]
        selected = select_unique_clips(
            candidates=[],
            desired_count=1,
            duration_sec=30,
            min_dur=15,
            max_dur=25,
            segments=segments,
        )
        self.assertEqual(len(selected), 1)
        self.assertLess(selected[0]["startSec"], 2.0)
        self.assertGreater(selected[0]["endSec"], 22.0)
        self.assertIn("useful conclusion", selected[0]["transcript"])


if __name__ == "__main__":
    unittest.main()
