#!/usr/bin/env python3
"""
ClipForge AI — 12-Stage Chunk-Capable Video Analysis & Automated Editing Pipeline
Supports videos up to 10 hours (36,000s) with bounded constant RAM, global timestamps,
chunk-boundary deduplication, temporary file cleanup per chunk, and checkpoint recovery.
"""
import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, List

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from processor.chunking.chunk_manager import (
    MAX_TEN_HOURS_SEC,
    build_chunk_plan,
    load_checkpoint,
    save_checkpoint_atomic,
)
from processor.ingestion.validator import validate_source_media
from processor.transcription.audio_extractor import (
    extract_chunk_pcm_wav,
    extract_embedded_srt,
)
from processor.transcription.transcriber import (
    merge_chunk_segments_deduplicated,
    parse_srt_file,
    transcribe_chunk_media,
)
from processor.analysis.scene_detector import detect_window_scenes_and_faces
from processor.analysis.content_analyzer import analyze_audio_and_silence_profile
from processor.clip_detection.moment_detector import detect_candidate_moments
from processor.clip_detection.clip_selector import select_unique_clips
from processor.video_editor.reframer import compute_reframe_filter
from processor.video_editor.subtitle_generator import (
    extract_clip_caption_cues,
    generate_ass_subtitles,
)
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


def emit_checkpoint_progress(
    completed_chunks: int,
    total_chunks: int,
    current_chunk_index: int,
    chunk_duration_sec: float,
    chunk_overlap_sec: float,
) -> None:
    payload = {
        "enabled": total_chunks > 1,
        "chunkDurationSec": chunk_duration_sec,
        "chunkOverlapSec": chunk_overlap_sec,
        "totalChunks": total_chunks,
        "completedChunks": completed_chunks,
        "currentChunkIndex": current_chunk_index,
    }
    print(f"CF_CHECKPOINT:{json.dumps(payload)}", flush=True)


def _remove_file_safe(path_str: str) -> None:
    try:
        if path_str and os.path.isfile(path_str):
            os.remove(path_str)
    except Exception:
        pass


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
    max_duration_sec = float(job_cfg.get("maxDurationSec") or MAX_TEN_HOURS_SEC)
    checkpoint_path = str(job_cfg.get("checkpointPath") or "")

    # Stage 1: Importing
    emit_progress("importing", 5, "Verifying local source media availability...")
    if not os.path.isfile(source_path):
        raise RuntimeError("Source media file missing during importing stage")

    # Stage 2: Validating
    emit_progress("validating", 10, "Running FFprobe container and stream integrity checks...")
    probe = validate_source_media(source_path, ffprobe_path, max_duration_sec=max_duration_sec)
    duration_sec = float(probe["durationSec"])

    preset = str(settings.get("durationPreset") or "15-30")
    if preset in DURATION_BOUNDS:
        min_dur, max_dur = DURATION_BOUNDS[preset]
    else:
        min_dur = float(settings.get("customMinDuration") or 15.0)
        max_dur = float(settings.get("customMaxDuration") or 30.0)
    desired_count = max(1, min(10, int(settings.get("clipCount") or 3)))

    if mode == "regenerate_clip" and job_cfg.get("regenerateSpec"):
        spec = job_cfg["regenerateSpec"]
        c_s = max(0.0, float(spec["startSec"]))
        c_e = min(duration_sec, float(spec["endSec"]))
        c_span = max(1.0, c_e - c_s)

        emit_progress("extracting_audio", 24, "Extracting target clip audio slice...")
        regen_wav = extract_chunk_pcm_wav(
            source_path=source_path,
            work_dir=work_dir,
            ffmpeg_path=ffmpeg_path,
            has_audio=bool(probe["hasAudio"]),
            start_sec=c_s,
            duration_sec=c_span,
            chunk_index=0,
        )
        embedded_srt = (
            extract_embedded_srt(source_path, work_dir, ffmpeg_path)
            if probe.get("hasEmbeddedSubtitles")
            else None
        )
        embedded_segs = parse_srt_file(embedded_srt) if embedded_srt else None

        emit_progress("transcribing", 40, "Aligning word timestamps for target clip...")
        tr_result = transcribe_chunk_media(
            wav_path=regen_wav,
            win_start=c_s,
            win_end=c_e,
            embedded_global_segments=embedded_segs,
            whisper_model_size=str(job_cfg.get("whisperModelSize") or "base"),
            whisper_model_path=str(job_cfg.get("whisperModelPath") or ""),
            whisper_device=str(job_cfg.get("whisperDevice") or "cpu"),
            whisper_compute_type=str(job_cfg.get("whisperComputeType") or "int8"),
            language=str(settings.get("language") or "en"),
        )
        all_segments = tr_result["segments"]

        emit_progress("detecting_scenes", 52, "Tracking speaker framing on target clip...")
        all_scenes = detect_window_scenes_and_faces(
            source_path=source_path,
            start_sec=c_s,
            end_sec=c_e,
            sample_interval_sec=0.5,
        )
        emit_progress("analyzing_content", 60, "Profiling boundary silence on target clip...")
        audio_prof = analyze_audio_and_silence_profile(
            wav_path=regen_wav,
            silence_threshold_db=float(settings.get("silenceThresholdDb", -38.0)),
            min_silence_sec=float(settings.get("silenceMinDurationSec", 0.6)),
            offset_sec=c_s,
        )
        _remove_file_safe(regen_wav)
        all_silence_intervals = audio_prof["silenceIntervals"]
        emit_progress("detecting_moments", 66, "Loading target clip timestamps for re-render...")
        emit_progress("selecting_clips", 72, "Preparing single clip regeneration...")
        selected_clips = [
            {
                "startSec": c_s,
                "endSec": c_e,
                "durationSec": round(c_span, 2),
                "transcript": str(spec.get("transcript") or ""),
                "title": str(spec.get("title") or "Regenerated Clip"),
                "category": str(spec.get("category") or "insight"),
                "reason": str(spec.get("selectionReason") or "User-requested clip regeneration."),
                "engagementScore": int(spec.get("engagementScore") or 75),
            }
        ]
        used_ai = False
        engine_used = tr_result["engine"]
        detected_lang = tr_result["detectedLanguage"]
        whisper_status = tr_result["whisperStatus"]
        warnings_list = tr_result["warnings"]
    else:
        # Chunk-based streaming pipeline supporting up to 10-hour (36,000s) videos
        chunk_duration_sec = float(
            settings.get("chunkDurationSec")
            or job_cfg.get("chunkDurationSec")
            or 600.0
        )
        chunk_overlap_sec = float(job_cfg.get("chunkOverlapSec") or 5.0)
        chunks = build_chunk_plan(
            duration_sec=duration_sec,
            chunk_duration_sec=chunk_duration_sec,
            chunk_overlap_sec=chunk_overlap_sec,
        )
        total_chunks = len(chunks)

        # Demux lightweight text subtitle stream once if present (no video/audio decoding)
        embedded_srt = (
            extract_embedded_srt(source_path, work_dir, ffmpeg_path)
            if probe.get("hasEmbeddedSubtitles")
            else None
        )
        embedded_global_segments = parse_srt_file(embedded_srt) if embedded_srt else None

        # Restore resumable checkpoint if server/worker restarted mid-job
        saved = load_checkpoint(checkpoint_path)
        if saved and int(saved.get("totalChunks", -1)) == total_chunks:
            completed_indices = set(int(i) for i in saved.get("completedChunkIndices", []))
            all_segments: List[Dict[str, Any]] = list(saved.get("segments") or [])
            all_scenes: List[Dict[str, Any]] = list(saved.get("scenes") or [])
            all_silence_intervals: List[Dict[str, Any]] = list(
                saved.get("silenceIntervals") or []
            )
            all_candidates: List[Dict[str, Any]] = list(saved.get("candidates") or [])
            used_ai = bool(saved.get("usedAi", False))
            engine_used = str(saved.get("transcriptionEngine") or "faster-whisper")
            detected_lang = str(saved.get("detectedLanguage") or "en")
            whisper_status = str(saved.get("whisperStatus") or "pending")
            warnings_list = list(saved.get("warnings") or [])
        else:
            completed_indices = set()
            all_segments = []
            all_scenes = []
            all_silence_intervals = []
            all_candidates = []
            used_ai = False
            engine_used = "faster-whisper"
            detected_lang = str(settings.get("language") or "en")
            whisper_status = "pending"
            warnings_list = []

        emit_checkpoint_progress(
            completed_chunks=len(completed_indices),
            total_chunks=total_chunks,
            current_chunk_index=0,
            chunk_duration_sec=chunk_duration_sec,
            chunk_overlap_sec=chunk_overlap_sec,
        )

        interrupt_after = int(job_cfg.get("simulateInterruptAfterChunk") or -1)

        for chunk in chunks:
            c_idx = int(chunk["index"])
            if c_idx in completed_indices:
                continue

            win_start = float(chunk["winStart"])
            win_end = float(chunk["winEnd"])
            core_start = float(chunk["coreStart"])
            core_end = float(chunk["coreEnd"])
            win_dur = max(0.5, win_end - win_start)

            chunk_label = (
                f"chunk {c_idx + 1}/{total_chunks} ({int(core_start)}s–{int(core_end)}s)"
                if total_chunks > 1
                else f"0s–{int(duration_sec)}s"
            )
            base_pct = 14 + int(round((c_idx / max(1, total_chunks)) * 56))

            # Stage 3 (per chunk): Extract bounded 16kHz PCM audio
            emit_progress(
                "extracting_audio",
                base_pct,
                f"Extracting 16kHz audio for {chunk_label}...",
            )
            chunk_wav = extract_chunk_pcm_wav(
                source_path=source_path,
                work_dir=work_dir,
                ffmpeg_path=ffmpeg_path,
                has_audio=bool(probe["hasAudio"]),
                start_sec=win_start,
                duration_sec=win_dur,
                chunk_index=c_idx,
            )

            try:
                # Stage 4 (per chunk): Transcribe with Faster-Whisper & shift to global timestamps
                emit_progress(
                    "transcribing",
                    min(70, base_pct + max(1, int(12 / total_chunks))),
                    f"Transcribing speech & global timestamps for {chunk_label}...",
                )
                tr_chunk = transcribe_chunk_media(
                    wav_path=chunk_wav,
                    win_start=win_start,
                    win_end=win_end,
                    embedded_global_segments=embedded_global_segments,
                    whisper_model_size=str(job_cfg.get("whisperModelSize") or "base"),
                    whisper_model_path=str(job_cfg.get("whisperModelPath") or ""),
                    whisper_device=str(job_cfg.get("whisperDevice") or "cpu"),
                    whisper_compute_type=str(job_cfg.get("whisperComputeType") or "int8"),
                    language=str(settings.get("language") or "en"),
                )
                engine_used = tr_chunk["engine"]
                detected_lang = tr_chunk["detectedLanguage"]
                whisper_status = tr_chunk["whisperStatus"]
                for w_msg in tr_chunk["warnings"]:
                    if w_msg not in warnings_list:
                        warnings_list.append(w_msg)

                prev_seg_tail = all_segments[-4:] if all_segments else []
                seg_count_before = len(all_segments)
                merge_chunk_segments_deduplicated(
                    accumulated=all_segments,
                    chunk_global_segments=tr_chunk["segments"],
                    core_start=core_start,
                    core_end=core_end,
                    is_first=bool(chunk["isFirst"]),
                    is_last=bool(chunk["isLast"]),
                )
                newly_merged_segs = all_segments[seg_count_before:]
                # Include 4 trailing segments from previous chunk so cross-seam moments are scored intact
                window_segs_for_scoring = prev_seg_tail + newly_merged_segs

                # Stage 5 (per chunk): Coarse scene sampling inside [core_start, core_end]
                emit_progress(
                    "detecting_scenes",
                    min(71, base_pct + max(2, int(24 / total_chunks))),
                    f"Scanning visual scenes for {chunk_label}...",
                )
                coarse_interval = (
                    0.5
                    if total_chunks == 1 and duration_sec <= 120.0
                    else max(4.0, round((core_end - core_start) / 16.0, 1))
                )
                chunk_scenes = detect_window_scenes_and_faces(
                    source_path=source_path,
                    start_sec=core_start,
                    end_sec=core_end,
                    sample_interval_sec=coarse_interval,
                )
                all_scenes.extend(chunk_scenes)

                # Stage 6 (per chunk): Streamed RMS energy & silence profiling
                emit_progress(
                    "analyzing_content",
                    min(72, base_pct + max(3, int(36 / total_chunks))),
                    f"Profiling vocal energy & silence for {chunk_label}...",
                )
                chunk_audio_prof = analyze_audio_and_silence_profile(
                    wav_path=chunk_wav,
                    silence_threshold_db=float(settings.get("silenceThresholdDb", -38.0)),
                    min_silence_sec=float(settings.get("silenceMinDurationSec", 0.6)),
                    offset_sec=win_start,
                    energy_step_sec=0.2 if win_dur <= 180.0 else 0.5,
                )
                for sil in chunk_audio_prof["silenceIntervals"]:
                    if sil["end"] > core_start and sil["start"] < core_end:
                        all_silence_intervals.append(sil)

                # Stage 7 (per chunk): AI + acoustic moment detection with global timestamps
                emit_progress(
                    "detecting_moments",
                    min(73, base_pct + max(4, int(48 / total_chunks))),
                    f"Identifying engaging moments in {chunk_label}...",
                )
                moment_res = detect_candidate_moments(
                    segments=window_segs_for_scoring,
                    scenes=chunk_scenes,
                    energy_timeline=chunk_audio_prof["energyTimeline"],
                    duration_sec=duration_sec,
                    min_dur=min_dur,
                    max_dur=max_dur,
                    clip_count=desired_count,
                    ai_provider=str(job_cfg.get("aiProvider") or "gemini"),
                    gemini_api_key=str(job_cfg.get("geminiApiKey") or ""),
                    gemini_model=str(job_cfg.get("geminiModel") or "gemini-2.5-flash"),
                    openai_api_key=str(job_cfg.get("openaiApiKey") or ""),
                    openai_base_url=str(
                        job_cfg.get("openaiBaseUrl") or "https://api.openai.com/v1"
                    ),
                    openai_model=str(job_cfg.get("openaiModel") or "gpt-4o-mini"),
                    window_start_sec=core_start,
                    window_end_sec=core_end,
                )
                if moment_res["usedAi"]:
                    used_ai = True
                all_candidates.extend(moment_res["candidates"])
            finally:
                # Immediately delete chunk WAV so temp disk never accumulates across 10-hour jobs
                _remove_file_safe(chunk_wav)

            completed_indices.add(c_idx)
            save_checkpoint_atomic(
                checkpoint_path,
                {
                    "totalChunks": total_chunks,
                    "completedChunkIndices": sorted(completed_indices),
                    "segments": all_segments,
                    "scenes": all_scenes,
                    "silenceIntervals": all_silence_intervals,
                    "candidates": all_candidates,
                    "usedAi": used_ai,
                    "transcriptionEngine": engine_used,
                    "detectedLanguage": detected_lang,
                    "whisperStatus": whisper_status,
                    "warnings": warnings_list,
                },
            )
            emit_checkpoint_progress(
                completed_chunks=len(completed_indices),
                total_chunks=total_chunks,
                current_chunk_index=c_idx + 1,
                chunk_duration_sec=chunk_duration_sec,
                chunk_overlap_sec=chunk_overlap_sec,
            )

            # Controlled interruption hook for automated restart-recovery verification
            if interrupt_after >= 0 and len(completed_indices) >= interrupt_after:
                raise RuntimeError(
                    f"SIMULATED_WORKER_INTERRUPTION_AFTER_CHUNK_{len(completed_indices)}"
                )

        _remove_file_safe(embedded_srt or "")

        # Stage 8: Global cross-chunk clip selection with boundary deduplication
        emit_progress(
            "selecting_clips",
            75,
            f"Selecting up to {desired_count} non-overlapping clips across {total_chunks} chunk(s)...",
        )
        selected_clips = select_unique_clips(
            candidates=all_candidates,
            desired_count=desired_count,
            duration_sec=duration_sec,
            min_dur=min_dur,
            max_dur=max_dur,
        )

    # Stage 9 & 10: Smart Editing (high-precision per-clip speaker reframing + ASS captions) & Rendering
    emit_progress(
        "editing",
        80,
        "Computing speaker-tracked crops, animated ASS captions, and audio mastering chains...",
    )

    aspect_ratio = str(settings.get("aspectRatio") or "9:16")
    caption_style = settings.get("captionStyle") or {}
    bg_music_style = str(settings.get("backgroundMusic") or "none")

    # User-edited caption cues for a single-clip re-render, if any. This reuses the same
    # ASS generator below rather than introducing a second caption pipeline.
    edited_caption_cues = None
    if mode == "regenerate_clip" and job_cfg.get("regenerateSpec"):
        raw_cues = job_cfg["regenerateSpec"].get("captionCues")
        if isinstance(raw_cues, list) and raw_cues:
            edited_caption_cues = raw_cues

    rendered_outputs: List[Dict[str, Any]] = []
    total_clips = max(1, len(selected_clips))

    for idx, clip_cand in enumerate(selected_clips):
        clip_num = idx + 1
        clip_work = os.path.join(work_dir, f"clip_{clip_num:02d}")
        os.makedirs(clip_work, exist_ok=True)

        c_start, c_end, did_trim = trim_boundary_dead_air(
            clip_start=float(clip_cand["startSec"]),
            clip_end=float(clip_cand["endSec"]),
            silence_intervals=all_silence_intervals,
            enabled=bool(settings.get("silenceRemovalEnabled", True)),
        )
        c_dur = max(1.0, round(c_end - c_start, 2))

        # High-precision 2fps OpenCV face/motion tracking specifically on [c_start, c_end]
        clip_scenes = (
            detect_window_scenes_and_faces(
                source_path=source_path,
                start_sec=c_start,
                end_sec=c_end,
                sample_interval_sec=0.5,
            )
            if duration_sec > 120.0
            else all_scenes
        )

        vf_base, target_w, target_h, vf_applied = compute_reframe_filter(
            src_w=int(probe["width"]),
            src_h=int(probe["height"]),
            aspect_ratio=aspect_ratio,
            scenes=clip_scenes,
            clip_start=c_start,
            clip_end=c_end,
            zoom_effects=bool(settings.get("zoomEffects", True)),
            editing_intensity=str(settings.get("editingIntensity") or "balanced"),
        )

        ass_file = os.path.join(clip_work, "captions.ass")

        if edited_caption_cues is None:
            sub_applied = generate_ass_subtitles(
                ass_path=ass_file,
                play_w=target_w,
                play_h=target_h,
                clip_start=c_start,
                clip_end=c_end,
                segments=all_segments,
                caption_style=caption_style,
                watermark_enabled=bool(settings.get("watermarkEnabled", False)),
                watermark_text=str(settings.get("watermarkText") or ""),
                intro_text=str(settings.get("introText") or ""),
                outro_text=str(settings.get("outroText") or ""),
            )
            clip_caption_cues, used_real_word_timings = extract_clip_caption_cues(
                segments=all_segments,
                clip_start=c_start,
                clip_end=c_end,
            )
            caption_source = (
                "word_timestamps" if used_real_word_timings else "segment_interpolated"
            )
        else:
            # Re-render with the user's edited word-timed cues (same generator/style).
            clip_caption_cues = [
                {
                    "startSec": round(float(c.get("startSec", 0.0)), 2),
                    "endSec": round(float(c.get("endSec", 0.0)), 2),
                    "text": str(c.get("text", "")).strip(),
                    "words": [
                        {
                            "word": str(w.get("word", "")).strip(),
                            "startSec": round(float(w.get("startSec", 0.0)), 2),
                            "endSec": round(float(w.get("endSec", 0.0)), 2),
                        }
                        for w in (c.get("words") or [])
                    ],
                }
                for c in edited_caption_cues
            ]
            caption_source = "edited"
            # Feed the edited cues back through the SAME ASS generator (clip-relative
            # segment form) so styling/animation stay identical to derived captions.
            sub_applied = generate_ass_subtitles(
                ass_path=ass_file,
                play_w=target_w,
                play_h=target_h,
                clip_start=0.0,
                clip_end=c_dur,
                # One segment per cue so each cue keeps its own timing window; when a
                # cue has no word timings the generator interpolates inside that window.
                segments=[
                    {
                        "start": cue["startSec"],
                        "end": cue["endSec"],
                        "text": cue["text"],
                        "words": [
                            {
                                "word": w["word"],
                                "start": w["startSec"],
                                "end": w["endSec"],
                            }
                            for w in (cue.get("words") or [])
                        ],
                    }
                    for cue in clip_caption_cues
                ],
                caption_style=caption_style,
                watermark_enabled=bool(settings.get("watermarkEnabled", False)),
                watermark_text=str(settings.get("watermarkText") or ""),
                intro_text=str(settings.get("introText") or ""),
                outro_text=str(settings.get("outroText") or ""),
            )
            if clip_caption_cues:
                sub_applied.append("Edited word-timed captions")

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
            f"Rendering clip {clip_num} of {total_clips} ({aspect_ratio} H.264 MP4 @ {c_start:.1f}s)...",
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
                "captions": clip_caption_cues,
                "captionSource": caption_source,
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

    # Keep stored Video.transcript / Video.scenes bounded if source was 10 hours long
    result = {
        "probe": probe,
        "transcriptionEngine": engine_used,
        "detectedLanguage": detected_lang,
        "transcript": all_segments[:2500],
        "scenes": all_scenes[:1500],
        "diagnostics": {
            "whisperStatus": whisper_status,
            "aiUsed": used_ai,
            "warnings": warnings_list,
        },
        "clips": rendered_outputs,
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

    emit_progress("completed", 100, "All clips rendered and validated.")


def main() -> None:
    parser = argparse.ArgumentParser(description="ClipForge AI Chunked Media Processor")
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
