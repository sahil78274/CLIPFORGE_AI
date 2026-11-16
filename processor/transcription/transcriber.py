import os
import re
import wave
import numpy as np
from typing import Any, Dict, List, Optional, Tuple

# Reuse loaded Faster-Whisper CTranslate2 model across chunks so multi-hour videos
# never reload model weights repeatedly into memory.
_CACHED_WHISPER_MODELS: Dict[Tuple[str, str, str], Any] = {}
_WHISPER_UNAVAILABLE_KEYS: set = set()


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


def shift_segments_to_global(
    local_segments: List[Dict[str, Any]], offset_sec: float
) -> List[Dict[str, Any]]:
    if abs(offset_sec) < 1e-6:
        return local_segments
    shifted: List[Dict[str, Any]] = []
    for seg in local_segments:
        g_start = round(float(seg["start"]) + offset_sec, 2)
        g_end = round(float(seg["end"]) + offset_sec, 2)
        words = []
        for w in seg.get("words") or []:
            words.append(
                {
                    "word": w["word"],
                    "start": round(float(w["start"]) + offset_sec, 3),
                    "end": round(float(w["end"]) + offset_sec, 3),
                    "probability": w.get("probability", 0.9),
                }
            )
        shifted.append(
            {
                "id": seg.get("id", 0),
                "start": g_start,
                "end": g_end,
                "text": seg["text"],
                "words": words,
            }
        )
    return shifted


def _segment_iou(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    if inter <= 0.0:
        return 0.0
    union = max(0.05, (a_end - a_start) + (b_end - b_start) - inter)
    return inter / union


def merge_chunk_segments_deduplicated(
    accumulated: List[Dict[str, Any]],
    chunk_global_segments: List[Dict[str, Any]],
    core_start: float,
    core_end: float,
    is_first: bool,
    is_last: bool,
) -> None:
    """
    Merges chunk segments into `accumulated` using midpoint chunk ownership and
    temporal/lexical boundary deduplication so sentences straddling chunk seams
    are neither truncated nor duplicated.
    """
    tail_window = accumulated[-12:] if accumulated else []

    for seg in chunk_global_segments:
        s_t = float(seg["start"])
        e_t = float(seg["end"])
        if e_t <= s_t:
            continue
        mid = 0.5 * (s_t + e_t)
        in_core = (is_first or mid >= core_start - 0.05) and (
            is_last or mid < core_end + 0.05
        )
        if not in_core:
            continue

        norm_txt = re.sub(r"[^a-z0-9]+", " ", seg["text"].lower()).strip()
        is_dup = False
        for prev in tail_window:
            if _segment_iou(s_t, e_t, float(prev["start"]), float(prev["end"])) > 0.42:
                is_dup = True
                break
            prev_txt = re.sub(r"[^a-z0-9]+", " ", prev["text"].lower()).strip()
            if (
                norm_txt
                and norm_txt == prev_txt
                and abs(s_t - float(prev["start"])) < 6.0
            ):
                is_dup = True
                break

        if not is_dup:
            copied = dict(seg)
            copied["id"] = len(accumulated)
            accumulated.append(copied)
            tail_window = accumulated[-12:]


def _try_faster_whisper(
    wav_path: str,
    model_size: str,
    model_path: str,
    device: str,
    compute_type: str,
    language: str,
) -> Optional[Tuple[List[Dict[str, Any]], str]]:
    target_model = model_path if (model_path and os.path.isdir(model_path)) else model_size
    cache_key = (target_model, device or "cpu", compute_type or "int8")
    if cache_key in _WHISPER_UNAVAILABLE_KEYS:
        return None

    model = _CACHED_WHISPER_MODELS.get(cache_key)
    if model is None:
        try:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                target_model,
                device=cache_key[1],
                compute_type=cache_key[2],
                local_files_only=bool(model_path and os.path.isdir(model_path)),
            )
            _CACHED_WHISPER_MODELS[cache_key] = model
        except Exception:
            _WHISPER_UNAVAILABLE_KEYS.add(cache_key)
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


def _build_acoustic_vad_segments_streaming(
    wav_path: str, duration_sec: float, global_offset_sec: float = 0.0
) -> List[Dict[str, Any]]:
    """Streams WAV in 10-second chunks (~320 KB RAM) to build fallback speech islands."""
    rms_vals: List[float] = []
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate() or 16000
        win = max(1, sr // 2)  # 0.5s windows
        wins_per_read = 20  # 10s per read
        while True:
            raw = wf.readframes(win * wins_per_read)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            for i in range(0, len(samples), win):
                chunk = samples[i : i + win]
                if chunk.size > 0:
                    rms_vals.append(float(np.sqrt(np.mean(chunk * chunk) + 1e-9)))

    if not rms_vals:
        end_d = round(min(duration_sec, 15.0), 2)
        return [
            {
                "id": 0,
                "start": 0.0,
                "end": end_d,
                "text": "[Audio track silent — visual clip segment]",
                "words": [],
            }
        ]

    median_rms = float(np.median(rms_vals))
    thresh = max(0.005, median_rms * 0.65)

    segments: List[Dict[str, Any]] = []
    cur_start: Optional[float] = None
    seg_id = 0
    for idx, val in enumerate(rms_vals):
        t = idx * 0.5
        if val >= thresh and cur_start is None:
            cur_start = t
        elif (val < thresh or t - (cur_start or 0.0) >= 8.5) and cur_start is not None:
            if t - cur_start >= 1.5:
                g_s = global_offset_sec + cur_start
                g_e = global_offset_sec + min(duration_sec, t)
                txt = f"Active spoken segment ({g_s:.1f}s to {g_e:.1f}s)."
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
        g_s = global_offset_sec + cur_start
        g_e = global_offset_sec + duration_sec
        txt = f"Active spoken segment ({g_s:.1f}s to {g_e:.1f}s)."
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
        step = min(15.0, max(3.0, duration_sec / 3.0))
        t = 0.0
        while t < duration_sec - 0.5 and len(segments) < 12:
            end_t = round(min(duration_sec, t + step), 2)
            g_s = global_offset_sec + t
            g_e = global_offset_sec + end_t
            txt = f"Media highlight segment ({g_s:.1f}s to {g_e:.1f}s)."
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


def transcribe_chunk_media(
    wav_path: str,
    win_start: float,
    win_end: float,
    embedded_global_segments: Optional[List[Dict[str, Any]]],
    whisper_model_size: str,
    whisper_model_path: str,
    whisper_device: str,
    whisper_compute_type: str,
    language: str,
) -> Dict[str, Any]:
    """
    Transcribes a single bounded audio chunk [win_start, win_end] and maps all segment
    and word timestamps to exact global video timestamps.
    """
    warnings: List[str] = []
    chunk_dur = max(0.5, win_end - win_start)

    # 1. Primary: Faster-Whisper on chunk WAV (with cached model reuse)
    fw_res = _try_faster_whisper(
        wav_path=wav_path,
        model_size=whisper_model_size,
        model_path=whisper_model_path,
        device=whisper_device,
        compute_type=whisper_compute_type,
        language=language,
    )
    if fw_res is not None:
        global_segs = shift_segments_to_global(fw_res[0], win_start)
        return {
            "engine": "faster-whisper",
            "whisperStatus": f"faster-whisper ({whisper_model_size})",
            "detectedLanguage": fw_res[1],
            "segments": global_segs,
            "warnings": warnings,
        }

    warnings.append(
        "Faster-Whisper CTranslate2 model weights are NOT CONFIGURED locally and HuggingFace Hub is unreachable offline. Set WHISPER_MODEL_PATH to a cached CTranslate2 directory."
    )

    # 2. Embedded Subtitle Stream slice for [win_start, win_end]
    if embedded_global_segments is not None:
        sliced = [
            s
            for s in embedded_global_segments
            if float(s["end"]) > win_start and float(s["start"]) < win_end
        ]
        return {
            "engine": "embedded_subtitles",
            "whisperStatus": "embedded_subtitles (Whisper weights offline)",
            "detectedLanguage": language if language != "auto" else "en",
            "segments": sliced,
            "warnings": warnings,
        }

    # 3. PocketSphinx Offline Acoustic ASR (for chunks <= 120s; skips slow phoneme lattice on silent multi-hour fallback)
    if chunk_dur <= 180.0:
        try:
            ps_segments = _try_pocketsphinx_offline(wav_path)
            if ps_segments:
                return {
                    "engine": "pocketsphinx_offline",
                    "whisperStatus": "pocketsphinx_offline (Whisper weights offline)",
                    "detectedLanguage": "en",
                    "segments": shift_segments_to_global(ps_segments, win_start),
                    "warnings": warnings,
                }
        except Exception as exc:
            warnings.append(f"PocketSphinx offline fallback warning: {exc}")

    # 4. Streaming Acoustic Energy VAD Segmentation
    local_vad = _build_acoustic_vad_segments_streaming(wav_path, chunk_dur, win_start)
    return {
        "engine": "acoustic_vad_segments",
        "whisperStatus": "acoustic_vad (Whisper weights Not Configured)",
        "detectedLanguage": language if language != "auto" else "en",
        "segments": shift_segments_to_global(local_vad, win_start),
        "warnings": warnings,
    }


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
    embedded_segs = (
        parse_srt_file(embedded_srt_path)
        if (embedded_srt_path and os.path.isfile(embedded_srt_path))
        else None
    )
    return transcribe_chunk_media(
        wav_path=wav_path,
        win_start=0.0,
        win_end=duration_sec,
        embedded_global_segments=embedded_segs,
        whisper_model_size=whisper_model_size,
        whisper_model_path=whisper_model_path,
        whisper_device=whisper_device,
        whisper_compute_type=whisper_compute_type,
        language=language,
    )
