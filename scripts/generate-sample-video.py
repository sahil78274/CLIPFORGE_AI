#!/usr/bin/env python3
"""
Generates a real multi-scene 1280x720 30fps H.264 MP4 test video with speech-modulated
audio and an embedded SRT subtitle track for end-to-end pipeline verification.
"""
import argparse
import math
import os
import subprocess
import tempfile
import wave
import cv2
import numpy as np


SAMPLE_SEGMENTS = [
    (
        0.3,
        6.2,
        "Most creators lose viewers in the first three seconds because they open with slow introductions instead of the core takeaway.",
    ),
    (
        6.8,
        13.2,
        "Here is the framework that changed our retention: start every clip with a clear tension question, then show the concrete example immediately.",
    ),
    (
        13.9,
        20.5,
        "Surprisingly, trimming half a second of dead air between sentences keeps vertical viewers engaged all the way to the finalinsight.",
    ),
    (
        21.0,
        25.6,
        "Test three concise title hooks per episode and measure completion rate rather than chasing vanity impressions.",
    ),
]


def _fmt_srt_ts(sec: float) -> str:
    ms = int(round((sec - int(sec)) * 1000))
    s = int(sec) % 60
    m = (int(sec) // 60) % 60
    h = int(sec) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_sample_video(output_path: str, ffmpeg_path: str, duration_sec: float = 26.0) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    fps = 24
    width, height = 1280, 720
    total_frames = int(duration_sec * fps)

    with tempfile.TemporaryDirectory() as tmp:
        raw_avi = os.path.join(tmp, "visual.avi")
        wav_file = os.path.join(tmp, "speech.wav")
        srt_file = os.path.join(tmp, "transcript.srt")

        # 1. Generate multi-scene OpenCV video frames with distinct palettes & speaker motion
        fourcc = cv2.VideoWriter_fourcc(*"MJPG")
        writer = cv2.VideoWriter(raw_avi, fourcc, fps, (width, height))

        scene_palettes = [
            ((28, 22, 48), (180, 110, 255), 0.36),  # Scene 1: Speaker on left-center
            ((22, 38, 46), (245, 190, 60), 0.64),   # Scene 2: Speaker on right-center
            ((32, 24, 34), (130, 225, 160), 0.50),  # Scene 3: Center studio view
            ((20, 26, 44), (250, 130, 120), 0.44),  # Scene 4: Summary card
        ]

        for f_idx in range(total_frames):
            t = f_idx / float(fps)
            sc_idx = min(3, int(t // 6.5))
            bg_bgr, accent_bgr, base_x = scene_palettes[sc_idx]

            frame = np.full((height, width, 3), bg_bgr, dtype=np.uint8)
            # Subtle animated speaker silhouette / focal region so OpenCV motion saliency tracks X
            cx = int(width * base_x + 28 * math.sin(t * 2.4))
            cy = int(height * 0.46 + 10 * math.cos(t * 1.8))

            # Shoulders & head silhouette
            cv2.ellipse(frame, (cx, cy + 155), (125, 95), 0, 180, 360, accent_bgr, -1)
            cv2.circle(frame, (cx, cy), 68, (225, 210, 200), -1)
            # Eyes & mouth animation for natural motion energy
            cv2.circle(frame, (cx - 22, cy - 12), 7, (35, 35, 45), -1)
            cv2.circle(frame, (cx + 22, cy - 12), 7, (35, 35, 45), -1)
            mouth_h = 6 + int(10 * abs(math.sin(t * 9.0)))
            cv2.ellipse(frame, (cx, cy + 24), (20, mouth_h), 0, 0, 360, (60, 50, 75), -1)

            cv2.putText(
                frame,
                f"CLIPFORGE STUDIO TEST SCENE {sc_idx + 1}  |  T={t:04.1f}s",
                (48, 56),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.75,
                (230, 230, 240),
                2,
                cv2.LINE_AA,
            )
            writer.write(frame)

        writer.release()

        # 2. Generate speech-cadence harmonic audio with natural pauses matching SAMPLE_SEGMENTS
        sr = 24000
        n_samples = int(duration_sec * sr)
        t_arr = np.linspace(0.0, duration_sec, n_samples, endpoint=False)
        audio = np.zeros(n_samples, dtype=np.float32)

        for seg_s, seg_e, _ in SAMPLE_SEGMENTS:
            mask = (t_arr >= seg_s) & (t_arr <= seg_e)
            seg_t = t_arr[mask]
            syllable_env = 0.45 + 0.55 * np.abs(np.sin(2.0 * np.pi * 4.2 * seg_t))
            f0 = 155.0 + 18.0 * np.sin(2.0 * np.pi * 0.7 * seg_t)
            voice = (
                0.55 * np.sin(2.0 * np.pi * f0 * seg_t)
                + 0.28 * np.sin(2.0 * np.pi * (2.0 * f0) * seg_t)
                + 0.17 * np.sin(2.0 * np.pi * (3.0 * f0) * seg_t)
            ) * syllable_env
            audio[mask] = voice * 0.42

        pcm = np.clip(audio * 32767.0, -32767, 32767).astype(np.int16)
        with wave.open(wav_file, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())

        # 3. Write SRT transcript
        srt_lines = []
        for idx, (s_t, e_t, text) in enumerate(SAMPLE_SEGMENTS, start=1):
            srt_lines.append(f"{idx}\n{_fmt_srt_ts(s_t)} --> {_fmt_srt_ts(e_t)}\n{text}\n")
        with open(srt_file, "w", encoding="utf-8") as sf:
            sf.write("\n".join(srt_lines))

        # 4. Mux H.264 video + AAC audio + mov_text subtitle stream into MP4
        proc = subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-i",
                raw_avi,
                "-i",
                wav_file,
                "-i",
                srt_file,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-c:s",
                "mov_text",
                "-movflags",
                "+faststart",
                output_path,
            ],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Failed to mux sample MP4: {proc.stderr[-400:]}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True)
    p.add_argument("--ffmpeg", default="ffmpeg")
    args = p.parse_args()
    build_sample_video(args.output, args.ffmpeg)
    print(f"Sample MP4 generated: {args.output} ({os.path.getsize(args.output)} bytes)")
