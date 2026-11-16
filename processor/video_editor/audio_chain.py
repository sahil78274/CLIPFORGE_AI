import os
import wave
import numpy as np
from typing import Any, Dict, List, Optional, Tuple


def trim_boundary_dead_air(
    clip_start: float,
    clip_end: float,
    silence_intervals: List[Dict[str, float]],
    enabled: bool,
) -> Tuple[float, float, bool]:
    """
    Trims leading and trailing dead-air silence on BOTH video and audio boundaries
    simultaneously so A/V and ASS word timestamps never drift out of sync.
    """
    if not enabled or (clip_end - clip_start) < 4.0:
        return clip_start, clip_end, False

    new_start = clip_start
    new_end = clip_end
    trimmed = False

    for sil in silence_intervals:
        # Leading silence overlapping start
        if sil["start"] <= new_start + 0.15 and sil["end"] > new_start + 0.35:
            candidate = min(sil["end"] - 0.1, new_end - 2.5)
            if candidate > new_start:
                new_start = round(candidate, 2)
                trimmed = True
        # Trailing silence overlapping end
        if sil["end"] >= new_end - 0.15 and sil["start"] < new_end - 0.35:
            candidate = max(sil["start"] + 0.15, new_start + 2.5)
            if candidate < new_end:
                new_end = round(candidate, 2)
                trimmed = True

    return new_start, new_end, trimmed


def synthesize_licensed_ambient_bed(
    work_dir: str, duration_sec: float, style: str
) -> Optional[str]:
    if not style or style == "none":
        return None

    sr = 24000
    n = int(max(1.0, duration_sec + 0.5) * sr)
    t = np.linspace(0.0, n / float(sr), n, endpoint=False)

    if style == "subtle_pulse":
        # Warm C-major ambient pulse synthesized cleanly in-house (100% royalty-free)
        lfo = 0.65 + 0.35 * np.sin(2.0 * np.pi * 1.2 * t)
        sig = (
            0.45 * np.sin(2.0 * np.pi * 130.81 * t)
            + 0.30 * np.sin(2.0 * np.pi * 196.00 * t)
            + 0.25 * np.sin(2.0 * np.pi * 246.94 * t)
        ) * lfo
    else:
        # Ambient studio pad (A minor 9th gentle bed)
        lfo = 0.75 + 0.25 * np.sin(2.0 * np.pi * 0.25 * t)
        sig = (
            0.45 * np.sin(2.0 * np.pi * 110.00 * t)
            + 0.30 * np.sin(2.0 * np.pi * 164.81 * t)
            + 0.25 * np.sin(2.0 * np.pi * 246.94 * t)
        ) * lfo

    # Normalize softly so when mixed under voice it sits ~ -22dB below speech
    sig = sig / (np.max(np.abs(sig)) + 1e-6) * 0.08
    pcm = (sig * 32767.0).astype(np.int16)

    bed_path = os.path.join(work_dir, f"ambient_{style}.wav")
    with wave.open(bed_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return bed_path


def build_audio_filter_chain(
    clip_dur: float,
    noise_reduction: bool,
    audio_normalization: bool,
) -> Tuple[str, List[str]]:
    filters: List[str] = []
    applied: List[str] = []

    if noise_reduction:
        filters.append("highpass=f=75")
        filters.append("afftdn=nf=-25")
        applied.append("FFT noise reduction")

    if audio_normalization:
        filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
        applied.append("EBU R128 loudness normalization")

    fade_out_st = max(0.0, round(clip_dur - 0.25, 2))
    filters.append("afade=t=in:st=0:d=0.15")
    if fade_out_st > 0.2:
        filters.append(f"afade=t=out:st={fade_out_st}:d=0.25")

    return ",".join(filters), applied
