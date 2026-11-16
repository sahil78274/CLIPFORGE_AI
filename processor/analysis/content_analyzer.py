import wave
import numpy as np
from typing import Any, Dict, List


def analyze_audio_and_silence_profile(
    wav_path: str, silence_threshold_db: float, min_silence_sec: float
) -> Dict[str, Any]:
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return {"energyTimeline": [], "silenceIntervals": []}

    hop = max(1, int(sr * 0.1))  # 100ms resolution
    energy_timeline: List[Dict[str, float]] = []
    linear_thresh = float(10.0 ** (silence_threshold_db / 20.0))

    silence_intervals: List[Dict[str, float]] = []
    sil_start = None

    for idx in range(0, len(samples), hop):
        chunk = samples[idx : idx + hop]
        rms = float(np.sqrt(np.mean(chunk * chunk) + 1e-10))
        t = idx / float(sr)
        energy_timeline.append({"t": round(t, 2), "rms": round(rms, 5)})

        if rms < linear_thresh:
            if sil_start is None:
                sil_start = t
        else:
            if sil_start is not None and (t - sil_start) >= min_silence_sec:
                silence_intervals.append({"start": round(sil_start, 2), "end": round(t, 2)})
            sil_start = None

    total_dur = len(samples) / float(sr)
    if sil_start is not None and (total_dur - sil_start) >= min_silence_sec:
        silence_intervals.append({"start": round(sil_start, 2), "end": round(total_dur, 2)})

    return {
        "energyTimeline": energy_timeline,
        "silenceIntervals": silence_intervals,
    }
