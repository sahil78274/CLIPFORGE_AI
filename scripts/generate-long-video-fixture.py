#!/usr/bin/env python3
"""
Fast generator for genuine FFprobe-verified H.264 + AAC + mov_text MP4 fixtures
spanning arbitrary durations (36s, 1h = 3,600s, 5h = 18,000s, 10h = 36,000s).

Encodes a single 60s H.264+AAC segment with 1s GOP keyframes and remuxes via
FFmpeg's concat demuxer (-c:v copy -c:a copy) plus a full-timeline SRT track,
producing valid multi-hour MP4 containers in a few seconds without exhausting disk/RAM.
"""
import argparse
import math
import os
import subprocess
import tempfile
import wave
import cv2
import numpy as np


def _fmt_srt_ts(sec: float) -> str:
    ms = int(round((sec - int(sec)) * 1000))
    if ms >= 1000:
        sec += 1.0
        ms = 0
    total_s = int(sec)
    s = total_s % 60
    m = (total_s // 60) % 60
    h = total_s // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _build_base_unit(unit_mp4: str, ffmpeg_path: str, unit_dur: int = 60) -> None:
    fps = 6
    width, height = 640, 360
    total_frames = unit_dur * fps

    with tempfile.TemporaryDirectory() as tmp:
        raw_avi = os.path.join(tmp, "unit.avi")
        wav_path = os.path.join(tmp, "unit.wav")

        writer = cv2.VideoWriter(
            raw_avi, cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height)
        )
        palettes = [
            ((30, 24, 52), (180, 110, 255), 0.38),
            ((22, 40, 48), (245, 190, 65), 0.62),
            ((34, 24, 38), (120, 225, 165), 0.50),
        ]
        for f_idx in range(total_frames):
            t = f_idx / float(fps)
            bg, accent, bx = palettes[int(t // 20) % len(palettes)]
            frame = np.full((height, width, 3), bg, dtype=np.uint8)
            cx = int(width * bx + 18 * math.sin(t * 2.1))
            cy = int(height * 0.46 + 6 * math.cos(t * 1.6))
            cv2.ellipse(frame, (cx, cy + 85), (70, 52), 0, 180, 360, accent, -1)
            cv2.circle(frame, (cx, cy), 38, (225, 210, 200), -1)
            writer.write(frame)
        writer.release()

        sr = 16000
        n = unit_dur * sr
        t_arr = np.linspace(0.0, float(unit_dur), n, endpoint=False)
        env = 0.35 + 0.65 * np.abs(np.sin(2.0 * math.pi * 3.8 * t_arr))
        # Insert periodic natural breath pauses every ~12s
        pause_mask = (np.mod(t_arr, 12.0) > 11.1)
        sig = (
            0.5 * np.sin(2.0 * math.pi * 165.0 * t_arr)
            + 0.3 * np.sin(2.0 * math.pi * 330.0 * t_arr)
        ) * env * 0.35
        sig[pause_mask] = 0.0
        pcm = np.clip(sig * 32767.0, -32768, 32767).astype(np.int16)

        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())

        subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-i",
                raw_avi,
                "-i",
                wav_path,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "35",
                "-g",
                "6",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "32k",
                unit_mp4,
            ],
            check=True,
            capture_output=True,
        )


def _generate_timeline_srt(srt_path: str, total_duration_sec: int) -> None:
    """
    Populates spoken cues across the entire multi-hour video, including cues right across
    10-minute (600s) chunk boundaries and high-signal hooks in the opening, middle, and final hour.
    """
    cues = []

    chapter_scripts = [
        (
            "Here is the counterintuitive product lesson: teams obsess over acquisition funnels while ignoring first-minute activation friction.",
            "Why do ninety percent of SaaS trials stall before day three, and how does removing two onboarding steps reverse churn?",
            "Once our engineering team simplified the first workflow, weekly active retention climbed thirty eight percent immediately.",
        ),
        (
            "Surprisingly, podcast growth rarely comes from longer episodes; it comes from packaging each distinct story as a standalone hook.",
            "What happens when you open every clip with tension instead of guest introductions or housekeeping announcements?",
            "Creators who cut straight to the turning point earn triple the watch-through rate across vertical video feeds.",
        ),
        (
            "The biggest distributed systems mistake is loading gigabytes of raw media into memory instead of streaming bounded chunks.",
            "How can a background worker process a ten hour keynote reliably without running out of RAM during peak traffic?",
            "Persisting atomic checkpoints after each ten minute window makes crash recovery completely deterministic after restarts.",
        ),
        (
            "Pricing architecture shapes customer trust: transparent credit reservations protect users whenever external networks fail.",
            "Should any creator lose paid credits if an upstream stream disconnects halfway through rendering their episode?",
            "Settling wallet balances only after every rendered clip passes validation eliminates billing disputes completely.",
        ),
        (
            "Great storytelling relies on contrast: state the conventional wisdom first, then reveal the exact experiment that disproved it.",
            "Notice how audience energy spikes the moment a speaker shares specific numbers rather than abstract theory?",
            "Ending with one actionable takeaway gives viewers a clear reason to share the clip with their teammates today.",
        ),
    ]

    win_counter = [0]

    def add_window(base_t: float, label: str) -> None:
        if base_t + 24.0 > total_duration_sec:
            return
        s1, s2, s3 = chapter_scripts[win_counter[0] % len(chapter_scripts)]
        win_counter[0] += 1
        cues.append((base_t + 0.4, base_t + 7.6, f"[{label}] {s1}"))
        cues.append((base_t + 8.1, base_t + 15.8, s2))
        cues.append((base_t + 16.3, base_t + 23.4, s3))

    if total_duration_sec <= 120:
        if total_duration_sec >= 54:
            add_window(1.0, "opening chapter")
            add_window(28.0, "second chapter")
        else:
            # Compact < 54s short video: place two distinct 16s chapters so 2 non-overlapping 15-30s clips fit cleanly
            cues.append((0.6, 8.2, "[chapter one] Most creators lose viewers in the first three seconds by opening with slow housekeeping instead of tension."))
            cues.append((8.6, 16.8, "Ask one specific question immediately so vertical viewers stay hooked all the way through the example."))
            if total_duration_sec >= 35:
                cues.append((18.5, 26.4, "[chapter two] Pricing transparency builds lasting user trust whenever external networks fail unexpectedly."))
                cues.append((26.9, min(float(total_duration_sec) - 0.5, 35.2), "Refunding reserved credits automatically on failed jobs eliminates customer billing friction."))
    else:
        # Place engaging windows in early, mid, boundary-seam, and late chapters
        add_window(12.0, "hour one kickoff")
        # Deliberately straddle the 600s chunk seam (594s..618s) to verify boundary deduplication!
        if total_duration_sec >= 650:
            add_window(594.0, "ten minute chunk seam")
        # Deliberately straddle 1800s seam
        if total_duration_sec >= 1900:
            add_window(1794.0, "thirty minute seam")
        # Place periodic chapter insights every 20 minutes across 1h / 5h / 10h
        step = 1200
        t = 1200
        while t + 30 < total_duration_sec - 120:
            hour_num = int(t // 3600) + 1
            add_window(float(t), f"hour {hour_num} deep dive at {t}s")
            t += step
        # Always place a high-signal finale insight in the final 5 minutes of the video
        final_t = max(40.0, float(total_duration_sec - 210))
        add_window(final_t, f"final chapter at {int(final_t)}s")

    cues.sort(key=lambda x: x[0])
    lines = []
    for idx, (s_t, e_t, text) in enumerate(cues, start=1):
        lines.append(f"{idx}\n{_fmt_srt_ts(s_t)} --> {_fmt_srt_ts(e_t)}\n{text}\n")

    with open(srt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def build_long_fixture(output_path: str, ffmpeg_path: str, duration_sec: int, base_unit_cache: str = "") -> None:
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        if duration_sec < 60:
            unit_mp4 = os.path.join(tmp, "short_unit.mp4")
            _build_base_unit(unit_mp4, ffmpeg_path, unit_dur=duration_sec)
            srt_path = os.path.join(tmp, "subs.srt")
            _generate_timeline_srt(srt_path, duration_sec)
            subprocess.run(
                [
                    ffmpeg_path,
                    "-y",
                    "-i",
                    unit_mp4,
                    "-i",
                    srt_path,
                    "-c:v",
                    "copy",
                    "-c:a",
                    "copy",
                    "-c:s",
                    "mov_text",
                    "-movflags",
                    "+faststart",
                    output_path,
                ],
                check=True,
                capture_output=True,
            )
            return

        unit_mp4 = base_unit_cache if base_unit_cache else os.path.join(tmp, "unit_60s.mp4")
        if not os.path.isfile(unit_mp4):
            os.makedirs(os.path.dirname(os.path.abspath(unit_mp4)), exist_ok=True)
            _build_base_unit(unit_mp4, ffmpeg_path, unit_dur=60)

        repeats = max(1, duration_sec // 60)
        concat_txt = os.path.join(tmp, "concat.txt")
        escaped_unit = os.path.abspath(unit_mp4).replace("'", "'\\''")
        with open(concat_txt, "w", encoding="utf-8") as f:
            for _ in range(repeats):
                f.write(f"file '{escaped_unit}'\n")

        srt_path = os.path.join(tmp, "subs.srt")
        _generate_timeline_srt(srt_path, repeats * 60)

        subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                concat_txt,
                "-i",
                srt_path,
                "-t",
                str(duration_sec),
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-c:s",
                "mov_text",
                "-movflags",
                "+faststart",
                output_path,
            ],
            check=True,
            capture_output=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--duration", type=int, required=True)
    parser.add_argument("--unit-cache", default="")
    args = parser.parse_args()
    build_long_fixture(args.output, args.ffmpeg, args.duration, args.unit_cache)
