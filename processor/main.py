#!/usr/bin/env python3
"""
ClipForge AI — 12-Stage Video Analysis & Automated Editing Pipeline
Stages:
  1. importing
  2. validating
  3. extracting_audio
  4. transcribing
  5. detecting_scenes
  6. analyzing_content
  7. detecting_moments
  8. selecting_clips
  9. editing
  10. rendering
  11. validating_output
  12. completed
"""
import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, List

# Allow running directly as `python processor/main.py`
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from processor.ingestion.validator import validate_source_media
from processor.transcription.audio_extractor import extract_embedded_srt, extract_pcm_wav
from processor.transcription.transcriber import transcribe_media
from processor.analysis.scene_detector import detect_scenes_and_faces
from processor.analysis.content_analyzer import analyze_audio_and_silence_profile
from processor.clip_detection.moment_detector import detect_candidate_moments
from processor.clip_detection.clip_selector import select_unique_clips
from processor.video_editor.reframer import compute_reframe_filter
from processor.video_editor.subtitle_generator import generate_ass_subtitles
from processor.video_editor.audio_chain import (
    build_audio_filter_chain,
    synthesize_licensed_ambient_bed,
    trim_boundary_dead_air,
)
from processor.rendering.renderer import render_single_clip
from processor.rendering.output_validator import validate_rendered_clip


DURATION_BOUNDS = {
    "15-30": (15.0, 30.0),
    "30-45": (30.0, 45.0),
    "45-60": (45.0, 60.0),
    "60-90": (60.0, 90.0),
}


def emit_progress(stage: str, percent: int, message: str) -> None:
    payload = {"stage": stage, "percent": max(0, min(100, int(percent))), "message": message}
    print(f"CF_EVENT:{json.dumps(payload)}", flush=True)


def run_pipeline(job_cfg: Dict[str, Any], output_json_path: str) -> None:
    source_path = job_cfg["sourceVideoPath"]
    output_dir = job_cfg["outputDir"]
    work_dir = os.path.join(os.path.dirname(output_json_path), "work")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)

    ffmpeg_path = job_cfg.get("ffmpegPath") or "ffmpeg"
    ffprobe_path = job_cfg.get("ffprobePath") or "ffprobe"
    settings = job_cfg.get("settings") or {}
    mode = job_cfg.get("mode") or "full_pipeline"

    # Stage 1: Importing
    emit_progress("importing", 5, "Verifying local source media availability...")
    if not os.path.isfile(source_path):
        raise RuntimeError("Source media file missing during importing stage")

    # Stage 2: Validating
    emit_progress("validating", 12, "Running FFprobe container and stream integrity checks...")
    probe = validate_source_media(source_path, ffprobe_path)
    duration_sec = float(probe["durationSec"])

    # Stage 3: Extracting Audio
    emit_progress("extracting_audio", 22, "Extracting 16kHz PCM audio waveform...")
    wav_path = extract_pcm_wav(
        source_path=source_path,
        work_dir=work_dir,
        ffmpeg_path=ffmpeg_path,
        has_audio=bool(probe["hasAudio"]),
        duration_sec=duration_sec,
    )
    embedded_srt = (
        extract_embedded_srt(source_path, work_dir, ffmpeg_path)
        if probe.get("hasEmbeddedSubtitles")
        else None
    )

    # Stage 4: Transcribing
    emit_progress("transcribing", 34, "Transcribing spoken dialogue and word timestamps...")
    tr_result = transcribe_media(
        wav_path=wav_path,
        embedded_srt_path=embedded_srt,
        duration_sec=duration_sec,
        whisper_model_size=str(job_cfg.get("whisperModelSize") or "base"),
        whisper_model_path=str(job_cfg.get("whisperModelPath") or ""),
        whisper_device=str(job_cfg.get("whisperDevice") or "cpu"),
        whisper_compute_type=str(job_cfg.get("whisperComputeType") or "int8"),
        language=str(settings.get("language") or "en"),
    )
    segments = tr_result["segments"]

    # Stage 5: Detecting Scenes & Faces
    emit_progress(
        "detecting_scenes",
        48,
        "Running OpenCV scene cut, motion saliency, and speaker face tracking...",
    )
    scenes = detect_scenes_and_faces(source_path, duration_sec)

    # Stage 6: Analyzing Content
    emit_progress("analyzing_content", 58, "Profiling vocal energy and dead-air thresholds...")
    audio_profile = analyze_audio_and_silence_profile(
        wav_path=wav_path,
        silence_threshold_db=float(settings.get("silenceThresholdDb", -38.0)),
        min_silence_sec=float(settings.get("silenceMinDurationSec", 0.6)),
    )

    if mode == "regenerate_clip" and job_cfg.get("regenerateSpec"):
        spec = job_cfg["regenerateSpec"]
        emit_progress("detecting_moments", 66, "Loading target clip timestamps for re-render...")
        emit_progress("selecting_clips", 72, "Preparing single clip regeneration...")
        selected_clips = [
            {
                "startSec": float(spec["startSec"]),
                "endSec": float(spec["endSec"]),
                "durationSec": round(float(spec["endSec"]) - float(spec["startSec"]), 2),
                "transcript": str(spec.get("transcript") or ""),
                "title": str(spec.get("title") or "Regenerated Clip"),
                "category": str(spec.get("category") or "insight"),
                "reason": str(spec.get("selectionReason") or "User-requested clip regeneration."),
                "engagementScore": int(spec.get("engagementScore") or 75),
            }
        ]
        used_ai = False
    else:
        # Stage 7: Detecting Interesting Moments
        emit_progress(
            "detecting_moments",
            66,
            "Scoring hooks, insights, and complete sentence boundaries...",
        )
        preset = str(settings.get("durationPreset") or "15-30")
        if preset in DURATION_BOUNDS:
            min_dur, max_dur = DURATION_BOUNDS[preset]
        else:
            min_dur = float(settings.get("customMinDuration") or 15.0)
            max_dur = float(settings.get("customMaxDuration") or 30.0)

        desired_count = max(1, min(10, int(settings.get("clipCount") or 3)))
        moment_res = detect_candidate_moments(
            segments=segments,
            scenes=scenes,
            energy_timeline=audio_profile["energyTimeline"],
            duration_sec=duration_sec,
            min_dur=min_dur,
            max_dur=max_dur,
            clip_count=desired_count,
            gemini_api_key=str(job_cfg.get("geminiApiKey") or ""),
            gemini_model=str(job_cfg.get("geminiModel") or "gemini-2.5-flash"),
        )
        used_ai = bool(moment_res["usedAi"])

        # Stage 8: Selecting Clips
        emit_progress(
            "selecting_clips",
            74,
            f"Selecting up to {desired_count} non-overlapping highlight clips...",
        )
        selected_clips = select_unique_clips(
            candidates=moment_res["candidates"],
            desired_count=desired_count,
            duration_sec=duration_sec,
        )

    # Stage 9 & 10: Editing & Rendering
    emit_progress(
        "editing",
        80,
        "Generating OpenCV crop coordinates, ASS animated captions, and audio filters...",
    )

    aspect_ratio = str(settings.get("aspectRatio") or "9:16")
    caption_style = settings.get("captionStyle") or {}
    bg_music_style = str(settings.get("backgroundMusic") or "none")

    rendered_outputs: List[Dict[str, Any]] = []
    total_clips = max(1, len(selected_clips))

    for idx, clip_cand in enumerate(selected_clips):
        clip_num = idx + 1
        clip_work = os.path.join(work_dir, f"clip_{clip_num:02d}")
        os.makedirs(clip_work, exist_ok=True)

        c_start, c_end, did_trim = trim_boundary_dead_air(
            clip_start=float(clip_cand["startSec"]),
            clip_end=float(clip_cand["endSec"]),
            silence_intervals=audio_profile["silenceIntervals"],
            enabled=bool(settings.get("silenceRemovalEnabled", True)),
        )
        c_dur = max(1.0, round(c_end - c_start, 2))

        vf_base, target_w, target_h, vf_applied = compute_reframe_filter(
            src_w=int(probe["width"]),
            src_h=int(probe["height"]),
            aspect_ratio=aspect_ratio,
            scenes=scenes,
            clip_start=c_start,
            clip_end=c_end,
            zoom_effects=bool(settings.get("zoomEffects", True)),
            editing_intensity=str(settings.get("editingIntensity") or "balanced"),
        )

        ass_file = os.path.join(clip_work, "captions.ass")
        sub_applied = generate_ass_subtitles(
            ass_path=ass_file,
            play_w=target_w,
            play_h=target_h,
            clip_start=c_start,
            clip_end=c_end,
            segments=segments,
            caption_style=caption_style,
            watermark_enabled=bool(settings.get("watermarkEnabled", False)),
            watermark_text=str(settings.get("watermarkText") or ""),
            intro_text=str(settings.get("introText") or ""),
            outro_text=str(settings.get("outroText") or ""),
        )

        af_chain, af_applied = build_audio_filter_chain(
            clip_dur=c_dur,
            noise_reduction=bool(settings.get("noiseReduction", True)),
            audio_normalization=bool(settings.get("audioNormalization", True)),
        )
        if did_trim:
            af_applied.insert(0, "Synchronized dead-air silence trim")

        ambient_wav = synthesize_licensed_ambient_bed(clip_work, c_dur, bg_music_style)
        if ambient_wav:
            af_applied.append(f"Licensed ambient bed ({bg_music_style})")

        pct = 82 + int(round((idx / total_clips) * 12))
        emit_progress(
            "rendering",
            pct,
            f"Rendering clip {clip_num} of {total_clips} ({aspect_ratio} H.264 MP4)...",
        )

        out_mp4 = os.path.join(output_dir, f"clip_{clip_num:02d}.mp4")
        out_jpg = os.path.join(output_dir, f"clip_{clip_num:02d}.jpg")

        render_single_clip(
            ffmpeg_path=ffmpeg_path,
            source_path=source_path,
            clip_work_dir=clip_work,
            output_mp4_path=out_mp4,
            output_thumb_path=out_jpg,
            start_sec=c_start,
            duration_sec=c_dur,
            video_filter_base=vf_base,
            has_ass_file=os.path.isfile(ass_file),
            has_source_audio=bool(probe["hasAudio"]),
            audio_filter_chain=af_chain,
            ambient_bed_path=ambient_wav,
        )

        rendered_outputs.append(
            {
                "localVideoPath": out_mp4,
                "localThumbPath": out_jpg if os.path.isfile(out_jpg) else None,
                "title": clip_cand["title"],
                "startSec": c_start,
                "endSec": c_end,
                "durationSec": c_dur,
                "aspectRatio": aspect_ratio,
                "transcript": clip_cand["transcript"],
                "selectionReason": clip_cand["reason"],
                "category": clip_cand["category"],
                "engagementScore": clip_cand["engagementScore"],
                "editingApplied": vf_applied + sub_applied + af_applied,
            }
        )

    # Stage 11: Validating Output
    emit_progress(
        "validating_output",
        96,
        f"Validating {len(rendered_outputs)} rendered MP4 files with FFprobe...",
    )
    for item in rendered_outputs:
        verified = validate_rendered_clip(item["localVideoPath"], ffprobe_path)
        item["fileSizeBytes"] = verified["fileSizeBytes"]
        item["width"] = verified["width"]
        item["height"] = verified["height"]
        item["durationSec"] = verified["durationSec"]

    result = {
        "probe": probe,
        "transcriptionEngine": tr_result["engine"],
        "detectedLanguage": tr_result["detectedLanguage"],
        "transcript": segments,
        "scenes": scenes,
        "diagnostics": {
            "whisperStatus": tr_result["whisperStatus"],
            "aiUsed": used_ai,
            "warnings": tr_result["warnings"],
        },
        "clips": rendered_outputs,
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

    emit_progress("completed", 100, "All clips rendered and validated.")


def main() -> None:
    parser = argparse.ArgumentParser(description="ClipForge AI Media Processor")
    parser.add_argument("--input", required=True, help="Path to job_input.json")
    parser.add_argument("--output", required=True, help="Path to job_result.json")
    args = parser.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8") as f:
            job_cfg = json.load(f)
        run_pipeline(job_cfg, args.output)
    except Exception as exc:
        err_payload = {
            "error": str(exc),
            "trace": traceback.format_exc()[-1000:],
        }
        print(f"CF_ERROR:{json.dumps(err_payload)}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
