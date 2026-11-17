"""Pipeline integration checks for the source-wide language preflight."""
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest import mock

from processor import main as media_pipeline


GLOBAL_LANGUAGE = {
    "language": "hi",
    "languageProfile": "hi",
    "allowedLanguages": ["hi"],
    "languageConfidence": 0.93,
    "languageValidated": True,
    "sampleCount": 3,
    "sampleWindows": 3,
    "retryCount": 1,
}


class FullAudioLanguagePipelineTests(unittest.TestCase):
    def test_full_pipeline_detects_global_language_before_chunking_and_uses_it(self):
        result, events, transcribe = self._run_pipeline("full_pipeline")
        self.assertLess(events.index("language-detection"), events.index("chunk-plan"))
        self.assertLess(events.index("chunk-plan"), events.index("transcription"))
        self._assert_global_language_passed(result, transcribe)

    def test_regenerate_clip_uses_the_same_full_audio_language_decision(self):
        result, events, transcribe = self._run_pipeline("regenerate_clip")
        self.assertLess(events.index("language-detection"), events.index("transcription"))
        self.assertNotIn("chunk-plan", events)
        self._assert_global_language_passed(result, transcribe)

    def _assert_global_language_passed(self, result, transcribe):
        self.assertEqual(result["detectedLanguage"], "hi")
        self.assertEqual(result["diagnostics"]["detectedLanguageConfidence"], 0.93)
        self.assertEqual(result["diagnostics"]["languageProbeSampleCount"], 3)
        self.assertEqual(result["diagnostics"]["languageProbeRetryCount"], 1)
        self.assertTrue(result["diagnostics"]["captionsLanguageValidated"])
        call = transcribe.call_args.kwargs
        self.assertEqual(call["expected_language"], "hi")
        self.assertEqual(call["expected_languages"], ["hi"])
        self.assertEqual(call["expected_language_profile"], "hi")
        self.assertEqual(call["global_language_confidence"], 0.93)
        self.assertTrue(call["global_language_validated"])
        self.assertTrue(call["require_global_language_validation"])

    def _run_pipeline(self, mode):
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        root = tempdir.name
        source_path = os.path.join(root, "source.mp4")
        output_dir = os.path.join(root, "output")
        output_json_path = os.path.join(root, "result.json")
        with open(source_path, "wb") as source_file:
            source_file.write(b"mock media")

        events = []
        clip = {
            "startSec": 5.0,
            "endSec": 25.0,
            "durationSec": 20.0,
            "transcript": "नमस्ते, आज हम वीडियो की बात करेंगे।",
            "title": "Hindi clip",
            "category": "insight",
            "reason": "A representative test clip.",
            "engagementScore": 80,
        }
        probe = {
            "durationSec": 60.0,
            "width": 1920,
            "height": 1080,
            "hasAudio": True,
            "hasEmbeddedSubtitles": False,
        }
        transcribed_segment = {
            "id": 0,
            "start": 5.2,
            "end": 8.0,
            "text": "नमस्ते, आज हम वीडियो की बात करेंगे।",
            "words": [],
            "language": "hi",
            "languageProfile": "hi",
            "languageValidated": True,
            "captionable": True,
        }
        transcribed = {
            "engine": "faster-whisper",
            "detectedLanguage": "hi",
            "whisperStatus": "faster-whisper (small; full-audio=hi)",
            "segments": [transcribed_segment],
            "warnings": [],
        }

        def detect_language(**_kwargs):
            events.append("language-detection")
            return dict(GLOBAL_LANGUAGE)

        def build_plan(**_kwargs):
            events.append("chunk-plan")
            return [
                {
                    "index": 0,
                    "winStart": 0.0,
                    "winEnd": 60.0,
                    "coreStart": 0.0,
                    "coreEnd": 60.0,
                    "isFirst": True,
                    "isLast": True,
                }
            ]

        def transcribe(**_kwargs):
            events.append("transcription")
            return dict(transcribed)

        def extract_wav(**kwargs):
            return os.path.join(
                kwargs["work_dir"], f"test_chunk_{kwargs['chunk_index']}_16k.wav"
            )

        def patch(name, **kwargs):
            return mock.patch.object(media_pipeline, name, **kwargs)

        with ExitStack() as stack:
            transcribe_mock = stack.enter_context(
                patch("transcribe_chunk_media", side_effect=transcribe)
            )
            stack.enter_context(
                patch("detect_full_audio_language", side_effect=detect_language)
            )
            stack.enter_context(patch("validate_source_media", return_value=probe))
            stack.enter_context(patch("whisper_model_available", return_value=True))
            stack.enter_context(patch("extract_chunk_pcm_wav", side_effect=extract_wav))
            stack.enter_context(patch("extract_embedded_srt", return_value=None))
            stack.enter_context(patch("build_chunk_plan", side_effect=build_plan))
            stack.enter_context(patch("load_checkpoint", return_value=None))
            stack.enter_context(patch("save_checkpoint_atomic"))
            stack.enter_context(patch("emit_progress"))
            stack.enter_context(patch("emit_checkpoint_progress"))
            stack.enter_context(patch("detect_window_scenes_and_faces", return_value=[]))
            stack.enter_context(
                patch(
                    "analyze_audio_and_silence_profile",
                    return_value={"silenceIntervals": [], "energyTimeline": []},
                )
            )
            candidate_detection = stack.enter_context(
                patch(
                    "detect_candidate_moments",
                    return_value={"usedAi": False, "candidates": [clip]},
                )
            )
            stack.enter_context(
                mock.patch.dict(os.environ, {"GEMINI_API_KEY": "fake-gemini-key-for-tests-only"})
            )
            stack.enter_context(patch("select_unique_clips", return_value=[clip]))
            stack.enter_context(
                patch("trim_boundary_dead_air", side_effect=lambda clip_start, clip_end, **_kw: (clip_start, clip_end, False))
            )
            stack.enter_context(
                patch(
                    "compute_reframe_filter",
                    return_value=("null", 720, 1280, []),
                )
            )
            stack.enter_context(patch("generate_ass_subtitles", return_value=[]))
            stack.enter_context(patch("build_audio_filter_chain", return_value=("anull", [])))
            stack.enter_context(patch("synthesize_licensed_ambient_bed", return_value=None))
            stack.enter_context(patch("render_single_clip"))
            stack.enter_context(
                patch(
                    "validate_rendered_clip",
                    return_value={
                        "fileSizeBytes": 1024,
                        "width": 720,
                        "height": 1280,
                        "durationSec": 20.0,
                    },
                )
            )

            job_cfg = {
                "sourceVideoPath": source_path,
                "outputDir": output_dir,
                "mode": mode,
                "settings": {
                    "durationPreset": "15-30",
                    "clipCount": 1,
                    "silenceRemovalEnabled": False,
                    "backgroundMusic": "none",
                    "captionStyle": {"enabled": True},
                },
                "whisperModelSize": "small",
                "whisperModelPath": "",
                "whisperDevice": "cpu",
                "whisperComputeType": "int8",
            }
            if mode == "regenerate_clip":
                job_cfg["regenerateSpec"] = dict(clip)

            media_pipeline.run_pipeline(job_cfg, output_json_path)

        with open(output_json_path, encoding="utf-8") as result_file:
            result = json.load(result_file)
        self.assertEqual(transcribe_mock.call_count, 1)
        if mode == "full_pipeline":
            self.assertEqual(candidate_detection.call_count, 1)
            self.assertEqual(
                candidate_detection.call_args.kwargs["gemini_api_key"],
                "fake-gemini-key-for-tests-only",
            )
        return result, events, transcribe_mock


if __name__ == "__main__":
    unittest.main()
