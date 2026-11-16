import json
import os
import subprocess
from typing import Any, Dict


def validate_source_media(
    source_path: str,
    ffprobe_path: str,
    max_duration_sec: float = 36000.0,
) -> Dict[str, Any]:
    if not os.path.isfile(source_path):
        raise RuntimeError(f"Source video file does not exist: {source_path}")

    size_bytes = os.path.getsize(source_path)
    if size_bytes <= 0:
        raise RuntimeError("Source video file is 0 bytes")

    proc = subprocess.run(
        [
            ffprobe_path,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            source_path,
        ],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError("FFprobe rejected media container during validation stage")

    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    subtitle_streams = [s for s in streams if s.get("codec_type") == "subtitle"]

    if not video_stream:
        raise RuntimeError("No decodable video stream found in media file")

    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    duration_sec = float(
        (data.get("format") or {}).get("duration")
        or video_stream.get("duration")
        or 0.0
    )

    if width <= 0 or height <= 0 or duration_sec < 1.0:
        raise RuntimeError(
            f"Invalid video stream properties (width={width}, height={height}, duration={duration_sec:.2f}s)"
        )

    if duration_sec > max_duration_sec + 1.0:
        raise RuntimeError(
            f"Video duration ({duration_sec:.1f}s) exceeds maximum supported length ({max_duration_sec:.0f}s)"
        )

    rate_str = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "30/1"
    fps = 30.0
    if "/" in rate_str:
        num, den = rate_str.split("/", 1)
        if float(den) > 0:
            fps = float(num) / float(den)
    else:
        fps = float(rate_str or 30.0)

    return {
        "durationSec": round(duration_sec, 2),
        "width": width,
        "height": height,
        "fps": round(fps, 2),
        "codec": str(video_stream.get("codec_name") or "h264"),
        "audioCodec": str(audio_stream.get("codec_name")) if audio_stream else None,
        "hasAudio": audio_stream is not None,
        "hasEmbeddedSubtitles": len(subtitle_streams) > 0,
        "sizeBytes": size_bytes,
    }
