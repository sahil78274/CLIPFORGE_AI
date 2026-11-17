import os
import subprocess
from typing import List


def render_single_clip(
    ffmpeg_path: str,
    source_path: str,
    clip_work_dir: str,
    output_mp4_path: str,
    output_thumb_path: str,
    start_sec: float,
    duration_sec: float,
    video_filter_base: str,
    has_source_audio: bool,
) -> None:
    """Render a reframed clip without captions, text overlays, or audio alterations."""
    os.makedirs(clip_work_dir, exist_ok=True)
    os.makedirs(os.path.dirname(output_mp4_path), exist_ok=True)

    vf_full = f"{video_filter_base},format=yuv420p"
    cmd: List[str] = [
        ffmpeg_path,
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        source_path,
    ]

    if has_source_audio:
        # Map every source audio stream without filtering, mixing, or replacing it.
        cmd.extend(["-vf", vf_full, "-map", "0:v:0", "-map", "0:a?"])
    else:
        # Keep silent sources playable without inventing an audio track from other media.
        cmd.extend(
            [
                "-f",
                "lavfi",
                "-t",
                f"{duration_sec:.3f}",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-vf",
                vf_full,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-shortest",
            ]
        )

    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "22",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            output_mp4_path,
        ]
    )

    proc = subprocess.run(
        cmd,
        cwd=clip_work_dir,
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    if proc.returncode != 0:
        err_tail = (proc.stderr or "")[-500:]
        raise RuntimeError(f"FFmpeg clip rendering failed: {err_tail}")

    # Render a representative JPEG thumbnail from the rendered clip at 25% into it.
    thumb_t = max(0.1, round(duration_sec * 0.25, 2))
    thumb_proc = subprocess.run(
        [
            ffmpeg_path,
            "-y",
            "-ss",
            f"{thumb_t:.2f}",
            "-i",
            output_mp4_path,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            output_thumb_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if thumb_proc.returncode != 0:
        # Fall back to frame zero if seeking to the representative frame failed.
        subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-i",
                output_mp4_path,
                "-frames:v",
                "1",
                output_thumb_path,
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
