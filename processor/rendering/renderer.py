import os
import subprocess
from typing import List, Optional


def render_single_clip(
    ffmpeg_path: str,
    source_path: str,
    clip_work_dir: str,
    output_mp4_path: str,
    output_thumb_path: str,
    start_sec: float,
    duration_sec: float,
    video_filter_base: str,
    has_ass_file: bool,
    has_source_audio: bool,
    audio_filter_chain: str,
    ambient_bed_path: Optional[str],
) -> None:
    os.makedirs(clip_work_dir, exist_ok=True)
    os.makedirs(os.path.dirname(output_mp4_path), exist_ok=True)

    fade_out_start = max(0.0, round(duration_sec - 0.28, 2))
    vf_parts: List[str] = [video_filter_base]

    if has_ass_file:
        fonts_dir = "/usr/share/fonts/truetype/dejavu"
        if os.path.isdir(fonts_dir):
            vf_parts.append(f"ass=captions.ass:fontsdir={fonts_dir}")
        else:
            vf_parts.append("ass=captions.ass")

    vf_parts.append("fade=t=in:st=0:d=0.22")
    if fade_out_start > 0.3:
        vf_parts.append(f"fade=t=out:st={fade_out_start}:d=0.28")
    vf_parts.append("format=yuv420p")
    vf_full = ",".join(vf_parts)

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

    if ambient_bed_path and os.path.isfile(ambient_bed_path):
        cmd.extend(["-i", ambient_bed_path])

    if has_source_audio and ambient_bed_path and os.path.isfile(ambient_bed_path):
        filter_complex = (
            f"[0:v]{vf_full}[vout];"
            f"[0:a]{audio_filter_chain}[voice];"
            f"[1:a]atrim=0:{duration_sec:.3f},asetpts=PTS-STARTPTS[bed];"
            f"[voice][bed]amix=inputs=2:duration=first:dropout_transition=1[aout]"
        )
        cmd.extend(
            [
                "-filter_complex",
                filter_complex,
                "-map",
                "[vout]",
                "-map",
                "[aout]",
            ]
        )
    elif has_source_audio:
        cmd.extend(["-vf", vf_full, "-af", audio_filter_chain, "-map", "0:v:0", "-map", "0:a:0"])
    elif ambient_bed_path and os.path.isfile(ambient_bed_path):
        cmd.extend(["-vf", vf_full, "-map", "0:v:0", "-map", "1:a:0", "-shortest"])
    else:
        # Source video has no audio: attach clean silent AAC track for universal player compatibility
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

    # Render representative JPEG thumbnail from rendered clip at 25% into clip
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
        # Fallback to frame 0
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
