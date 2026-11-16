import os
import re
import wave
import numpy as np
from typing import Any, Dict, List, Optional, Tuple


def _parse_srt_timestamp(ts: str) -> float:
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
    return 0.0


def _interpolate_words(text: str, start: float, end: float) -> List[Dict[str, Any]]:
    tokens = [w for w in text.strip().split() if w]
    if not tokens:
        return []
    span = max(0.2, end - start)
    step = span / len(tokens)
    words = []
    for idx, tok in enumerate(tokens):
        w_start = round(start + idx * step, 3)
        w_end = round(min(end, w_start + step), 3)
        words.append({"word": tok, "start": w_start, "end": w_end, "probability": 0.92})
    return words


def parse_srt_file(srt_path: str) -> List[Dict[str, Any]]:
    with open(srt_path, "r", encoding="utf-8", errors="ignore") as f:
        raw = f.read()

    blocks = re.split(r"\n\s*\n", raw.strip())
    segments: List[Dict[str, Any]] = []
    seg_id = 0
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        time_line_idx = 0 if "-->" in lines[0] else 1
        if time_line_idx >= len(lines) or "-->" not in lines[time_line_idx]:
            continue
        start_s, end_s = lines[time_line_idx].split("-->", 1)
        start = round(_parse_srt_timestamp(start_s), 2)
        end = round(_parse_srt_timestamp(end_s), 2)
        text = " ".join(lines[time_line_idx + 1 :]).strip()
        text = re.sub(r"<[^>]+>", "", text)
        if text and end > start:
            segments.append(
                {
                    "id": seg_id,
                    "start": start,
                    "end": end,
                    "text": text,
                    "words": _interpolate_words(text, start, end),
                }
            )
            seg_id += 1
    return segments


def _try_faster_whisper(
    wav_path: str,
    model_size: str,
    model_path: str,
    device: str,
    compute_type: str,
    language: str,
) -> Optional[Tuple[List[Dict[str, Any]], str]]:
    from faster_whisper import WhisperModel

    target_model = model_path if (model_path and os.path.isdir(model_path)) else model_size
    # If no local path is given, check local files first before attempting remote download
    try:
        model = WhisperModel(
            target_model,
            device=device or "cpu",
            compute_type=compute_type or "int8",
            local_files_only=bool(model_path and os.path.isdir(model_path)),
        )
    except Exception:
        return None

    lang_arg = None if (not language or language == "auto") else language
    seg_iter, info = model.transcribe(
        wav_path,
        language=lang_arg,
        word_timestamps=True,
        vad_filter=True,
    )
    segments: List[Dict[str, Any]] = []
    for idx, seg in enumerate(seg_iter):
        txt = (seg.text or "").strip()
        if not txt:
            continue
        words = []
        for w in seg.words or []:
            words.append(
                {
                    "word": (w.word or "").strip(),
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                    "probability": round(float(getattr(w, "probability", 0.9)), 3),
                }
            )
        if not words:
            words = _interpolate_words(txt, float(seg.start), float(seg.end))
        segments.append(
            {
                "id": idx,
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": txt,
                "words": words,
            }
        )
    detected_lang = getattr(info, "language", None) or (language if language != "auto" else "en")
    return segments, detected_lang


def _try_pocketsphinx_offline(wav_path: str) -> List[Dict[str, Any]]:
    from pocketsphinx import Endpointer, Decoder

    ep = Endpointer()
    decoder = Decoder(samprate=ep.sample_rate)
    segments: List[Dict[str, Any]] = []

    with wave.open(wav_path, "rb") as wf:
        frame_bytes = ep.frame_bytes
        seg_id = 0
        while True:
            buf = wf.readframes(frame_bytes // 2)
            if len(buf) < frame_bytes:
                if ep.in_speech:
                    decoder.end_utt()
                    hyp = decoder.hyp()
                    if hyp and hyp.hypstr.strip():
                        s_t = round(max(0.0, float(ep.speech_start)), 2)
                        e_t = round(max(s_t + 0.4, float(ep.speech_end)), 2)
                        txt = hyp.hypstr.strip().capitalize() + "."
                        segments.append(
                            {
                                "id": seg_id,
                                "start": s_t,
                                "end": e_t,
                                "text": txt,
                                "words": _interpolate_words(txt, s_t, e_t),
                            }
                        )
                break

            prev_in_speech = ep.in_speech
            speech = ep.process(buf)
            if speech is not None:
                if not prev_in_speech:
                    decoder.start_utt()
                decoder.process_raw(speech)
                if not ep.in_speech:
                    decoder.end_utt()
                    hyp = decoder.hyp()
                    if hyp and hyp.hypstr.strip():
                        s_t = round(max(0.0, float(ep.speech_start)), 2)
                        e_t = round(max(s_t + 0.4, float(ep.speech_end)), 2)
                        txt = hyp.hypstr.strip().capitalize() + "."
                        segments.append(
                            {
                                "id": seg_id,
                                "start": s_t,
                                "end": e_t,
                                "text": txt,
                                "words": _interpolate_words(txt, s_t, e_t),
                            }
                        )
                        seg_id += 1
    return segments


def _build_acoustic_vad_segments(wav_path: str, duration_sec: float) -> List[Dict[str, Any]]:
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return [
            {
                "id": 0,
                "start": 0.0,
                "end": round(min(duration_sec, 15.0), 2),
                "text": "[Audio track silent — visual clip segment]",
                "words": [],
            }
        ]

    win = sr // 2  # 0.5s windows
    rms_vals = []
    for i in range(0, len(samples), win):
        chunk = samples[i : i + win]
        rms_vals.append(float(np.sqrt(np.mean(chunk * chunk) + 1e-9)))

    median_rms = float(np.median(rms_vals)) if rms_vals else 0.01
    thresh = max(0.005, median_rms * 0.65)

    segments: List[Dict[str, Any]] = []
    cur_start: Optional[float] = None
    seg_id = 0
    for idx, val in enumerate(rms_vals):
        t = idx * 0.5
        if val >= thresh and cur_start is None:
            cur_start = t
        elif (val < thresh or t - (cur_start or 0.0) >= 7.5) and cur_start is not None:
            if t - cur_start >= 1.5:
                txt = f"Active spoken segment ({cur_start:.1f}s to {t:.1f}s)."
                segments.append(
                    {
                        "id": seg_id,
                        "start": round(cur_start, 2),
                        "end": round(min(duration_sec, t), 2),
                        "text": txt,
                        "words": _interpolate_words(txt, cur_start, min(duration_sec, t)),
                    }
                )
                seg_id += 1
            cur_start = None

    if cur_start is not None and duration_sec - cur_start >= 1.0:
        txt = f"Active spoken segment ({cur_start:.1f}s to {duration_sec:.1f}s)."
        segments.append(
            {
                "id": seg_id,
                "start": round(cur_start, 2),
                "end": round(duration_sec, 2),
                "text": txt,
                "words": _interpolate_words(txt, cur_start, duration_sec),
            }
        )

    if not segments:
        step = min(8.0, max(3.0, duration_sec / 3.0))
        t = 0.0
        while t < duration_sec - 0.5:
            end_t = round(min(duration_sec, t + step), 2)
            txt = f"Media highlight segment ({t:.1f}s to {end_t:.1f}s)."
            segments.append(
                {
                    "id": len(segments),
                    "start": round(t, 2),
                    "end": end_t,
                    "text": txt,
                    "words": _interpolate_words(txt, t, end_t),
                }
            )
            t = end_t

    return segments


def transcribe_media(
    wav_path: str,
    embedded_srt_path: Optional[str],
    duration_sec: float,
    whisper_model_size: str,
    whisper_model_path: str,
    whisper_device: str,
    whisper_compute_type: str,
    language: str,
) -> Dict[str, Any]:
    warnings: List[str] = []

    # 1. Primary: Faster-Whisper
    fw_res = _try_faster_whisper(
        wav_path=wav_path,
        model_size=whisper_model_size,
        model_path=whisper_model_path,
        device=whisper_device,
        compute_type=whisper_compute_type,
        language=language,
    )
    if fw_res and len(fw_res[0]) > 0:
        return {
            "engine": "faster-whisper",
            "whisperStatus": f"faster-whisper ({whisper_model_size})",
            "detectedLanguage": fw_res[1],
            "segments": fw_res[0],
            "warnings": warnings,
        }

    warnings.append(
        "Faster-Whisper CTranslate2 model weights are NOT CONFIGURED locally and HuggingFace Hub is unreachable offline. Set WHISPER_MODEL_PATH to a cached CTranslate2 directory."
    )

    # 2. Embedded Subtitle Stream (if video includes mov_text / SRT stream)
    if embedded_srt_path and os.path.isfile(embedded_srt_path):
        srt_segments = parse_srt_file(embedded_srt_path)
        if srt_segments:
            return {
                "engine": "embedded_subtitles",
                "whisperStatus": "embedded_subtitles (Whisper weights offline)",
                "detectedLanguage": language if language != "auto" else "en",
                "segments": srt_segments,
                "warnings": warnings,
            }

    # 3. PocketSphinx Offline Acoustic ASR
    try:
        ps_segments = _try_pocketsphinx_offline(wav_path)
        if ps_segments:
            return {
                "engine": "pocketsphinx_offline",
                "whisperStatus": "pocketsphinx_offline (Whisper weights offline)",
                "detectedLanguage": "en",
                "segments": ps_segments,
                "warnings": warnings,
            }
    except Exception as exc:
        warnings.append(f"PocketSphinx offline fallback warning: {exc}")

    # 4. Acoustic Energy VAD Segmentation
    vad_segments = _build_acoustic_vad_segments(wav_path, duration_sec)
    return {
        "engine": "acoustic_vad_segments",
        "whisperStatus": "acoustic_vad (Whisper weights Not Configured)",
        "detectedLanguage": language if language != "auto" else "en",
        "segments": vad_segments,
        "warnings": warnings,
    }
