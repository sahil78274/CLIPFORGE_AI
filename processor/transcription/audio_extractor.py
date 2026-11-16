import os
import subprocess
import wave
from typing import Optional


def _write_silent_wav_streaming(wav_path: str, duration_sec: float, sample_rate: int = 16000) -> str:
    """Writes silent 16kHz PCM WAV in small 10s chunks without allocating full audio in RAM."""
    total_frames = int(max(1.0, duration_sec) * sample_rate)
    block_frames = sample_rate * 10
    zero_block = b"\x00\x00" * block_frames

    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        remaining = total_frames
        while remaining > 0:
            step = min(remaining, block_frames)
            if step == block_frames:
                wf.writeframes(zero_block)
            else:
                wf.writeframes(b"\x00\x00" * step)
            remaining -= step
    return wav_path


def extract_chunk_pcm_wav(
    source_path: str,
    work_dir: str,
    ffmpeg_path: str,
    has_audio: bool,
    start_sec: float,
    duration_sec: float,
    chunk_index: int = 0,
) -> str:
    """
    Extracts ONLY [start_sec, start_sec + duration_sec] of 16kHz mono PCM audio using
    O(1) input container seeking (-ss before -i) so multi-hour 10h videos never decode
    preceding hours or create multi-GB temporary WAV files.
    """
    os.makedirs(work_dir, exist_ok=True)
    wav_path = os.path.join(work_dir, f"chunk_{chunk_index:04d}_16k.wav")
    safe_dur = max(0.5, float(duration_sec))

    if has_audio:
        proc = subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-ss",
                f"{max(0.0, float(start_sec)):.3f}",
                "-t",
                f"{safe_dur:.3f}",
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
            timeout=180,
            check=False,
        )
        if proc.returncode == 0 and os.path.isfile(wav_path) and os.path.getsize(wav_path) > 44:
            return wav_path

    return _write_silent_wav_streaming(wav_path, safe_dur)


def extract_pcm_wav(
    source_path: str,
    work_dir: str,
    ffmpeg_path: str,
    has_audio: bool,
    duration_sec: float,
) -> str:
    return extract_chunk_pcm_wav(
        source_path=source_path,
        work_dir=work_dir,
        ffmpeg_path=ffmpeg_path,
        has_audio=has_audio,
        start_sec=0.0,
        duration_sec=duration_sec,
        chunk_index=0,
    )


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
        timeout=60,
        check=False,
    )
    if proc.returncode == 0 and os.path.isfile(srt_path) and os.path.getsize(srt_path) > 10:
        return srt_path
    return None
