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
from processor.main import _audio_language_sample_windows, _protect_spoken_word_boundaries


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

    def transcribe(
        self,
        outputs,
        language="auto",
        offset=0.0,
        expected_language=None,
        expected_languages=None,
        expected_profile="",
        global_confidence=0.0,
        global_validated=False,
        require_global=False,
    ):
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
                expected_language=expected_language,
                expected_languages=expected_languages,
                expected_language_profile=expected_profile,
                global_language_confidence=global_confidence,
                global_language_validated=global_validated,
                require_global_language_validation=require_global,
            )
        return result, fake

    def test_full_audio_probe_aggregates_samples_and_retries_outlier_with_global_language(self):
        def result(language, profile, text, probability=0.9):
            return {
                "detectedLanguage": language,
                "languageProfile": profile,
                "languageProbability": probability,
                "languageValidated": True,
                "segments": [{"text": text, "languageValidated": True}],
            }

        outputs = [
            result("hi", "hi", SAMPLE_UTTERANCES["hindi"]),
            result("en", "en", SAMPLE_UTTERANCES["english"]),
            result("hi", "hi", SAMPLE_UTTERANCES["hindi"]),
            result("hi", "hi", SAMPLE_UTTERANCES["hindi"]),
            result("hi", "hi", SAMPLE_UTTERANCES["english"]),
            result("hi", "hi", SAMPLE_UTTERANCES["hindi"]),
        ]
        with mock.patch.object(transcriber, "_try_faster_whisper", side_effect=outputs) as decode:
            detected = transcriber.detect_full_audio_language(
                ["beginning.wav", "middle.wav", "end.wav"],
                model_size="small",
                model_path="",
                device="cpu",
                compute_type="int8",
            )
        self.assertEqual(detected["language"], "hi")
        self.assertTrue(detected["languageValidated"])
        self.assertGreater(detected["retryCount"], 0)
        self.assertEqual(decode.call_count, 6)
        self.assertEqual(decode.call_args_list[3].kwargs["expected_language"], "hi")

    def test_global_language_confidence_requires_enough_supported_audio_windows(self):
        result = transcriber._aggregate_language_observations(
            [
                {
                    "language": "hi",
                    "profile": "hi",
                    "confidence": 0.95,
                    "text": SAMPLE_UTTERANCES["hindi"],
                }
            ],
            total_windows=3,
        )
        self.assertEqual(result["sampleCount"], 1)
        self.assertLess(result["languageConfidence"], 0.50)
        self.assertFalse(result["languageValidated"])

    def test_full_audio_hinglish_profile_keeps_hindi_and_english_allowed(self):
        text = SAMPLE_UTTERANCES["hinglish"]
        observed = {
            "detectedLanguage": "en",
            "languageProfile": "hinglish",
            "languageProbability": 0.93,
            "languageValidated": True,
            "segments": [{"text": text}],
        }
        with mock.patch.object(transcriber, "_try_faster_whisper", return_value=observed) as decode:
            detected = transcriber.detect_full_audio_language(
                ["beginning.wav", "middle.wav", "end.wav"],
                model_size="small",
                model_path="",
                device="cpu",
                compute_type="int8",
            )
        self.assertEqual(decode.call_count, 3)
        self.assertEqual(detected["language"], "hi")
        self.assertEqual(detected["languageProfile"], "hinglish")
        self.assertEqual(detected["allowedLanguages"], ["en", "hi"])
        self.assertTrue(detected["languageValidated"])

    def test_expected_full_audio_language_is_forced_and_wrong_scripts_are_withheld(self):
        hindi = SAMPLE_UTTERANCES["hindi"]
        result, fake = self.transcribe(
            [("hi", hindi)],
            expected_language="hi",
            expected_languages=["hi"],
            expected_profile="hi",
            global_confidence=0.92,
            global_validated=True,
            require_global=True,
        )
        self.assertEqual(fake.calls[0]["language"], "hi")
        self.assertEqual(fake.calls[0]["task"], "transcribe")
        self.assertTrue(result["languageValidated"])
        self.assertEqual(result["segments"][0]["text"], hindi)
        self.assertEqual(result["segments"][0]["language"], "hi")
        self.assertEqual(result["segments"][0]["languageProfile"], "hi")

        romanized_hindi = SAMPLE_UTTERANCES["hinglish"]
        result, fake = self.transcribe(
            [("hi", romanized_hindi), ("hi", romanized_hindi)],
            expected_language="hi",
            expected_languages=["hi"],
            expected_profile="hi",
            global_confidence=0.92,
            global_validated=True,
            require_global=True,
        )
        self.assertEqual([call["language"] for call in fake.calls], ["hi", "hi"])
        self.assertFalse(result["languageValidated"])
        self.assertFalse(result["segments"][0]["captionable"])

        hinglish, fake = self.transcribe(
            [("hi", romanized_hindi)],
            expected_language="hi",
            expected_languages=["hi", "en"],
            expected_profile="hinglish",
            global_confidence=0.92,
            global_validated=True,
            require_global=True,
        )
        self.assertTrue(hinglish["languageValidated"])
        self.assertEqual(hinglish["segments"][0]["text"], romanized_hindi)
        self.assertEqual(hinglish["languageProfile"], "hinglish")

        tamil = "வணக்கம் இன்று நாம் பேசுவோம்"
        result, fake = self.transcribe(
            [("hi", tamil), ("hi", tamil)],
            expected_language="hi",
            expected_languages=["hi"],
            global_confidence=0.92,
            global_validated=True,
            require_global=True,
        )
        self.assertEqual([call["language"] for call in fake.calls], ["hi", "hi"])
        self.assertFalse(result["languageValidated"])
        self.assertFalse(result["segments"][0]["captionable"])

    def test_full_audio_probe_windows_span_the_video_timeline(self):
        windows = _audio_language_sample_windows(36000.0)
        self.assertEqual(len(windows), 16)
        self.assertEqual(windows[0][0], 0.0)
        self.assertEqual(windows[-1][1], 36000.0)
        self.assertTrue(all(left[0] < right[0] for left, right in zip(windows, windows[1:])))

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

    def test_expected_english_accepts_generic_latin_text_and_global_confidence_gates_captions(self):
        result, fake = self.transcribe(
            [("en", "Good morning, everyone.")],
            expected_language="en",
            expected_languages=["en"],
            expected_profile="en",
            global_confidence=0.88,
            global_validated=True,
            require_global=True,
        )
        self.assertEqual(fake.calls[0]["language"], "en")
        self.assertTrue(result["languageValidated"])
        self.assertEqual(result["segments"][0]["text"], "Good morning, everyone.")

        result, fake = self.transcribe(
            [("en", SAMPLE_UTTERANCES["english"])],
            expected_language="en",
            expected_languages=["en"],
            expected_profile="en",
            global_confidence=0.32,
            global_validated=False,
            require_global=True,
        )
        self.assertEqual(fake.calls[0]["task"], "transcribe")
        self.assertFalse(result["languageValidated"])
        self.assertFalse(result["segments"][0]["captionable"])
        self.assertIn("Full-audio language detection", result["warnings"][0])

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
        safe_start, safe_end = _protect_spoken_word_boundaries(
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
            return_value=[
                None,
                "not an AI moment object",
                {"startSec": "invalid", "endSec": 18.7},
                {"startSec": float("nan"), "endSec": 18.7},
                {"startSec": 10.5, "endSec": 18.7, "title": "Complete thought"},
            ],
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

    def test_selector_returns_only_complete_unique_high_quality_moments(self):
        candidates = [
            {
                "startSec": 2.0,
                "endSec": 22.0,
                "durationSec": 20.0,
                "transcript": "Here is a useful idea that changed how we solve problems.",
                "engagementScore": 90,
                "completeThought": True,
                "audioEnergy": 0.12,
                "visualScore": 0.8,
            },
            {
                "startSec": 30.0,
                "endSec": 50.0,
                "durationSec": 20.0,
                "transcript": "This second explanation shows why the method saves more time.",
                "engagementScore": 82,
                "completeThought": True,
                "audioEnergy": 0.09,
                "visualScore": 0.6,
            },
            {
                "startSec": 58.0,
                "endSec": 78.0,
                "durationSec": 20.0,
                "transcript": "Here is a useful idea that changed how we solve problems.",
                "engagementScore": 95,
                "completeThought": True,
            },
            {
                "startSec": 2.0,
                "endSec": 22.0,
                "durationSec": 20.0,
                "transcript": "This is a complete sentence but the score is weak.",
                "engagementScore": 60,
                "completeThought": True,
            },
            {
                "startSec": 80.0,
                "endSec": 100.0,
                "durationSec": 20.0,
                "transcript": "A useful explanation that is mostly silent throughout.",
                "engagementScore": 92,
                "completeThought": True,
            },
            {
                "startSec": 82.0,
                "endSec": 102.0,
                "durationSec": 20.0,
                "transcript": "This high scoring moment ends in an unfinished thought",
                "engagementScore": 96,
                "completeThought": False,
            },
        ]
        selected = select_unique_clips(
            candidates=candidates,
            desired_count=5,
            duration_sec=110,
            min_dur=15,
            max_dur=25,
            silence_intervals=[{"start": 80.0, "end": 100.0}],
        )

        self.assertEqual(len(selected), 2)
        self.assertEqual([candidate["startSec"] for candidate in selected], [30.0, 58.0])
        self.assertTrue(all(candidate["completeThought"] for candidate in selected))

    def test_selector_ranks_equal_scores_with_audio_and_visual_context(self):
        low_context = {
            "startSec": 2.0,
            "endSec": 22.0,
            "durationSec": 20.0,
            "transcript": "A complete thought with a useful point about our process.",
            "engagementScore": 80,
            "completeThought": True,
            "audioEnergy": 0.01,
            "visualScore": 0.2,
        }
        high_context = {
            "startSec": 30.0,
            "endSec": 50.0,
            "durationSec": 20.0,
            "transcript": "Another complete thought explaining a practical strategy for teams.",
            "engagementScore": 80,
            "completeThought": True,
            "audioEnergy": 0.14,
            "visualScore": 0.9,
        }
        selected = select_unique_clips(
            candidates=[low_context, high_context],
            desired_count=1,
            duration_sec=60,
            min_dur=15,
            max_dur=25,
        )
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["startSec"], 30.0)

    def test_moment_detector_does_not_invent_visual_only_fallbacks(self):
        result = detect_candidate_moments(
            segments=[],
            scenes=[
                {
                    "start": 0.0,
                    "end": 60.0,
                    "score": 0.95,
                    "motionScore": 0.9,
                    "hasFace": True,
                    "analysisAvailable": True,
                }
            ],
            energy_timeline=[{"t": 30.0, "rms": 0.4}],
            duration_sec=60,
            min_dur=15,
            max_dur=30,
            clip_count=3,
        )
        self.assertEqual(result["candidates"], [])

    def test_unverified_transcript_hints_are_internal_and_need_strong_quality_signals(self):
        embedded_segments = [
            {
                "id": 0,
                "start": 1.0,
                "end": 10.0,
                "text": "The important lesson is to remove friction before adding features.",
                "words": [],
                "captionable": False,
                "languageValidated": False,
                "unverified": True,
            },
            {
                "id": 1,
                "start": 10.4,
                "end": 20.0,
                "text": "Teams that simplify onboarding retain more customers over time.",
                "words": [],
                "captionable": False,
                "languageValidated": False,
                "unverified": True,
            },
        ]
        scenes = [
            {
                "start": 0.0,
                "end": 30.0,
                "score": 0.9,
                "motionScore": 0.6,
                "hasFace": True,
                "analysisAvailable": True,
            }
        ]
        energy = [{"t": 5.0, "rms": 0.12}, {"t": 15.0, "rms": 0.12}]

        with mock.patch.object(
            moment_detector, "_try_gemini_moment_scoring", return_value=[]
        ) as score_with_ai:
            result = detect_candidate_moments(
                segments=embedded_segments,
                scenes=scenes,
                energy_timeline=energy,
                duration_sec=60.0,
                min_dur=15.0,
                max_dur=30.0,
                clip_count=1,
            )
        score_with_ai.assert_not_called()
        self.assertFalse(result["usedAi"])
        self.assertTrue(result["candidates"])
        candidate = result["candidates"][0]
        self.assertIn("important lesson", candidate["transcript"])
        self.assertFalse(candidate["transcriptVerified"])
        self.assertTrue(candidate["completeThought"])

        selected = select_unique_clips(
            candidates=[candidate],
            desired_count=1,
            duration_sec=60.0,
            min_dur=15.0,
            max_dur=30.0,
            segments=embedded_segments,
        )
        self.assertEqual(len(selected), 1)

        low_signal = detect_candidate_moments(
            segments=embedded_segments,
            scenes=[],
            energy_timeline=[],
            duration_sec=60.0,
            min_dur=15.0,
            max_dur=30.0,
            clip_count=1,
        )
        self.assertEqual(
            select_unique_clips(
                candidates=low_signal["candidates"],
                desired_count=1,
                duration_sec=60.0,
                min_dur=15.0,
                max_dur=30.0,
                segments=embedded_segments,
            ),
            [],
        )

    def test_selector_rejects_borderline_unverified_transcript_candidates(self):
        candidate = {
            "startSec": 1.0,
            "endSec": 21.0,
            "durationSec": 20.0,
            "transcript": "A complete idea with enough words to analyze.",
            "engagementScore": 69,
            "completeThought": True,
            "transcriptVerified": False,
        }
        selected = select_unique_clips(
            candidates=[candidate],
            desired_count=1,
            duration_sec=60.0,
            min_dur=15.0,
            max_dur=30.0,
        )
        self.assertEqual(selected, [])

    def test_selector_does_not_fill_missing_slots_from_transcript_windows(self):
        segments = [
            {
                "start": 2.0,
                "end": 11.0,
                "text": "The first complete sentence ends here.",
                "languageValidated": True,
            },
            {
                "start": 11.4,
                "end": 22.0,
                "text": "The next sentence finishes with a useful conclusion.",
                "languageValidated": True,
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
        self.assertEqual(selected, [])


if __name__ == "__main__":
    unittest.main()
