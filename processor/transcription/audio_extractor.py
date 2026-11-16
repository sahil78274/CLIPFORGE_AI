import os
import subprocess
import wave
import numpy as np
from typing import Optional


def extract_pcm_wav(
    source_path: str,
    work_dir: str,
    ffmpeg_path: str,
    has_audio: bool,
    duration_sec: float,
) -> str:
    wav_path = os.path.join(work_dir, "extracted_16k_mono.wav")
    if has_audio:
        proc = subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-i",
                source_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                wav_path,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if proc.returncode == 0 and os.path.isfile(wav_path) and os.path.getsize(wav_path) > 44:
            return wav_path

    # Generate silent 16kHz mono WAV if source video had no audio stream
    sample_rate = 16000
    samples = np.zeros(int(max(1.0, duration_sec) * sample_rate), dtype=np.int16)
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())
    return wav_path


def extract_embedded_srt(
    source_path: str, work_dir: str, ffmpeg_path: str
) -> Optional[str]:
    srt_path = os.path.join(work_dir, "embedded.srt")
    proc = subprocess.run(
        [
            ffmpeg_path,
            "-y",
            "-i",
            source_path,
            "-map",
            "0:s:0",
            srt_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode == 0 and os.path.isfile(srt_path) and os.path.getsize(srt_path) > 10:
        return srt_path
    return None
