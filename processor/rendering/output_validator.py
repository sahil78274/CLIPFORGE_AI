import json
import os
import subprocess
from typing import Any, Dict


def validate_rendered_clip(mp4_path: str, ffprobe_path: str) -> Dict[str, Any]:
    if not os.path.isfile(mp4_path):
        raise RuntimeError(f"Rendered clip output file is missing: {mp4_path}")

    file_size = os.path.getsize(mp4_path)
    if file_size < 1024:
        raise RuntimeError(f"Rendered clip file is unexpectedly small ({file_size} bytes)")

    proc = subprocess.run(
        [
            ffprobe_path,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            mp4_path,
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError("Rendered clip failed FFprobe output validation")

    info = json.loads(proc.stdout or "{}")
    streams = info.get("streams") or []
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not v_stream:
        raise RuntimeError("Rendered clip contains no decodable video stream")

    width = int(v_stream.get("width") or 0)
    height = int(v_stream.get("height") or 0)
    dur = float((info.get("format") or {}).get("duration") or v_stream.get("duration") or 0.0)

    if width <= 0 or height <= 0 or dur <= 0.3:
        raise RuntimeError("Rendered clip has invalid dimensions or zero duration")

    return {
        "fileSizeBytes": file_size,
        "width": width,
        "height": height,
        "durationSec": round(dur, 2),
    }
