import wave
import numpy as np
from typing import Any, Dict, List


def analyze_audio_and_silence_profile(
    wav_path: str,
    silence_threshold_db: float,
    min_silence_sec: float,
    offset_sec: float = 0.0,
    energy_step_sec: float = 0.2,
) -> Dict[str, Any]:
    """
    Streams PCM WAV in small 10-second chunks (~320 KB RAM) to compute global-timestamped
    RMS energy points and dead-air silence spans without loading full audio into RAM.
    """
    energy_timeline: List[Dict[str, float]] = []
    silence_intervals: List[Dict[str, float]] = []
    linear_thresh = float(10.0 ** (silence_threshold_db / 20.0))

    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate() or 16000
        hop = max(1, int(round(sr * max(0.05, energy_step_sec))))
        # Read integer multiple of hop frames (~10 seconds per block)
        hops_per_read = max(1, int((sr * 10) // hop))
        frames_per_read = hop * hops_per_read

        global_sample_offset = 0
        sil_start = None

        while True:
            raw = wf.readframes(frames_per_read)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if samples.size == 0:
                break

            for idx in range(0, len(samples), hop):
                chunk = samples[idx : idx + hop]
                if chunk.size == 0:
                    continue
                rms = float(np.sqrt(np.mean(chunk * chunk) + 1e-10))
                local_t = (global_sample_offset + idx) / float(sr)
                global_t = offset_sec + local_t
                energy_timeline.append({"t": round(global_t, 2), "rms": round(rms, 5)})

                if rms < linear_thresh:
                    if sil_start is None:
                        sil_start = global_t
                else:
                    if sil_start is not None and (global_t - sil_start) >= min_silence_sec:
                        silence_intervals.append(
                            {"start": round(sil_start, 2), "end": round(global_t, 2)}
                        )
                    sil_start = None

            global_sample_offset += len(samples)

        end_global_t = offset_sec + (global_sample_offset / float(sr))
        if sil_start is not None and (end_global_t - sil_start) >= min_silence_sec:
            silence_intervals.append(
                {"start": round(sil_start, 2), "end": round(end_global_t, 2)}
            )

    return {
        "energyTimeline": energy_timeline,
        "silenceIntervals": silence_intervals,
    }
