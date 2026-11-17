import os
import re
import unicodedata
import wave
from collections import Counter
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
    # Whisper normally supplies word alignment. For imported subtitle tracks and
    # offline fallbacks, use a character-weighted estimate rather than assigning
    # identical durations to a short word and a long one.
    span = max(0.02, end - start)
    weights = [max(1, len(token)) for token in tokens]
    total_weight = float(sum(weights))
    words = []
    elapsed = 0.0
    for tok, weight in zip(tokens, weights):
        w_start = round(start + elapsed, 3)
        elapsed += span * weight / total_weight
        w_end = round(min(end, start + elapsed), 3)
        words.append({"word": tok, "start": w_start, "end": w_end, "estimated": True})
    return words


_HINGLISH_WORDS = {
    "aaj", "abhi", "acha", "achha", "apna", "aap", "bahut", "bhi", "hai", "hain",
    "ho", "hoga", "hum", "iska", "iske", "kar", "kare", "karna", "karo", "ka", "ki",
    "ke", "ko", "kyun", "kyunki", "lekin", "main", "matlab", "mein", "mera", "mujhe",
    "nahi", "nahin", "par", "sab", "se", "tha", "thoda", "toh", "tum", "woh",
    "yaar", "yeh", "ye", "kya", "chahiye", "aur", "batao", "dekho", "bata", "raha",
    "rahi", "rahe", "kaise", "kahan", "bilkul", "wala", "wali",
}
_ENGLISH_CUES = {
    "the", "is", "are", "you", "we", "this", "that", "and", "it", "of", "to", "for",
    "in", "with", "today", "useful", "create", "clip", "clips", "video", "because", "how",
    "what", "when", "important", "building", "can", "will", "from", "your", "just", "really",
    "hello", "world", "thanks", "everyone", "welcome", "please", "about", "there", "here",
    "should", "would", "could", "first", "thing", "something", "making", "say", "look",
    "talk", "think", "know", "need", "want", "but", "not", "which", "my", "then", "than",
    "a", "an", "was", "were", "they", "she", "he", "at", "as", "by", "on", "or", "so",
    "do", "did", "have", "has", "had", "me", "all", "more", "one", "new", "meeting",
    "business", "content", "growth", "research", "product", "marketing", "data", "plan", "work",
    "better", "story", "question", "answer", "idea", "reason", "learn", "change", "focus",
    "example", "system", "challenge", "start", "stop", "team", "teams", "follow",
}
_ENGLISH_STRONG_CUES = {
    "hello", "world", "thanks", "welcome", "please", "today", "everyone", "building", "useful",
    "because", "something", "meeting", "business", "content", "research", "product", "marketing",
    "question", "answer", "idea", "example", "challenge", "follow", "think", "know", "should",
    "would", "could", "want", "need", "growth", "working", "video", "creator", "together",
    "we", "you", "this", "that", "are", "and", "the", "clips", "create",
}


def _normalize_language(language: Optional[str]) -> Optional[str]:
    """Return a base Whisper language code; 'auto' and product labels are not codes."""
    raw = str(language or "").strip().lower().replace("_", "-")
    if not raw or raw in {"auto", "und", "unknown", "multilingual", "hinglish", "hi-en", "en-hi"}:
        return None
    aliases = {"arabic": "ar", "hindi": "hi", "english": "en"}
    code = aliases.get(raw, raw.split("-", 1)[0])
    return code if len(code) in (2, 3) else None


def _script_counts(text: str) -> Counter:
    counts: Counter = Counter()
    for char in text or "":
        if not char.isalpha():
            continue
        name = unicodedata.name(char, "")
        if "DEVANAGARI" in name:
            counts["hi"] += 1
        elif "ARABIC" in name:
            counts["ar"] += 1
        elif "LATIN" in name:
            counts["latin"] += 1
        elif "CYRILLIC" in name:
            counts["ru"] += 1
        elif "BENGALI" in name:
            counts["bn"] += 1
        elif "GURMUKHI" in name:
            counts["pa"] += 1
        elif "TAMIL" in name:
            counts["ta"] += 1
        elif "TELUGU" in name:
            counts["te"] += 1
        elif "KANNADA" in name:
            counts["kn"] += 1
        elif "MALAYALAM" in name:
            counts["ml"] += 1
        elif "GUJARATI" in name:
            counts["gu"] += 1
        elif "THAI" in name:
            counts["th"] += 1
        else:
            counts["other"] += 1
    return counts


def _latin_language_hints(text: str) -> Tuple[int, int]:
    tokens = re.findall(r"[a-z]+", (text or "").lower())
    return (
        sum(1 for token in tokens if token in _HINGLISH_WORDS),
        sum(1 for token in tokens if token in _ENGLISH_CUES),
    )


def _strong_english_hits(text: str) -> int:
    tokens = re.findall(r"[a-z]+", (text or "").lower())
    return sum(1 for token in tokens if token in _ENGLISH_STRONG_CUES)


def _infer_transcript_language(text: str, detected_language: Optional[str] = None) -> Optional[str]:
    """Use script and conservative lexical cues to catch Whisper label conflicts."""
    counts = _script_counts(text)
    total = sum(counts.values())
    if not total:
        return None

    # Non-Latin scripts are highly diagnostic for the languages relevant here.
    for code in ("hi", "ar", "ta", "te", "kn", "ml", "gu", "bn", "pa", "ru", "th"):
        if counts[code] >= 3 and counts[code] / total >= 0.55:
            return code

    detected = _normalize_language(detected_language)
    # A script actually present in the transcript is not a conflict with the
    # dominant model label; it may be legitimate code-switching.
    if detected in {"ar", "fa", "ur"} and counts["ar"] >= 3:
        return None
    if detected in {"hi", "mr", "ne", "sa"} and counts["hi"] >= 3:
        return None
    hindi_hits, english_hits = _latin_language_hints(text)
    latin_count = counts["latin"]
    if latin_count >= 4 and latin_count / total >= 0.60:
        if hindi_hits >= 2:
            return "hi"
        # A clear English transcript contradicts an Arabic/Hindi Whisper label.
        if detected in {"ar", "fa", "ur", "hi", "mr", "ne", "sa"} and (
            english_hits >= 2 or _strong_english_hits(text) >= 1
        ):
            return "en"
    return None


def _language_conflict(detected_language: Optional[str], text: str) -> Optional[str]:
    detected = _normalize_language(detected_language)
    counts = _script_counts(text)
    hindi_hits, english_hits = _latin_language_hints(text)

    # A transcript already showing a compatible mixed-language profile is not a
    # language-label conflict. In particular, do not force Hindi on romanized
    # Hinglish when Whisper returned mixed English/Hindi words: that can rewrite
    # the recognized script without improving the language validation.
    profile = _language_profile(text, detected)
    if (detected in {"en", "hi"} and profile == "hinglish") or (
        detected in {"ar", "en"} and profile == "multilingual"
    ):
        return None

    # If Whisper says Arabic but the transcript contains no Arabic script and has
    # clear Devanagari/romanized Hindi or English evidence, retry instead of using
    # a misleading model label. Do the symmetric check for Hindi detections.
    if detected in {"ar", "fa", "ur"} and counts["ar"] < 3:
        if counts["hi"] >= 3 or hindi_hits >= 2:
            return "hi"
        if english_hits >= 2 or _strong_english_hits(text) >= 1:
            return "en"
    if detected in {"hi", "mr", "ne", "sa"} and counts["hi"] < 3:
        if counts["ar"] >= 3:
            return "ar"
        if (english_hits >= 2 or _strong_english_hits(text) >= 1) and hindi_hits < 2:
            return "en"

    inferred = _infer_transcript_language(text, detected)
    # Arabic script is shared by Arabic, Urdu, and Persian; Devanagari is shared
    # by Hindi, Marathi, Nepali, and Sanskrit. Do not retry across script siblings.
    compatible = {
        "ar": {"ar", "ur", "fa"},
        "hi": {"hi", "mr", "ne", "sa"},
    }
    if inferred and detected not in compatible.get(inferred, {inferred}):
        return inferred
    return None


def _language_profile(text: str, detected_language: Optional[str]) -> str:
    detected = _normalize_language(detected_language) or "und"
    counts = _script_counts(text)
    hindi_hits, english_hits = _latin_language_hints(text)
    has_hindi = counts["hi"] > 0 or hindi_hits >= 2
    has_english = counts["latin"] > 0 and (english_hits >= 2 or _strong_english_hits(text) >= 1)
    if has_hindi and has_english:
        return "hinglish"
    if counts["ar"] and counts["latin"] and english_hits:
        return "multilingual"
    return detected


def summarize_detected_language(segments: List[Dict[str, Any]], fallback: str = "und") -> str:
    """Summarize per-chunk Whisper labels without assuming one language for the video."""
    weights: Counter = Counter()
    profiles: Counter = Counter()
    for segment in segments:
        if not segment.get("languageValidated", segment.get("captionable", True)):
            continue
        language = _normalize_language(segment.get("language"))
        if not language:
            continue
        weight = max(1, len(str(segment.get("text") or "")))
        weights[language] += weight
        profile = str(segment.get("languageProfile") or "")
        if profile:
            profiles[profile] += weight
    if not weights:
        return _normalize_language(fallback) or "und"
    total_weight = sum(weights.values())
    if profiles.get("hinglish", 0) >= max(4, total_weight * 0.2):
        return "hinglish"
    if profiles.get("multilingual", 0) >= max(4, total_weight * 0.2):
        return "multilingual"
    total = float(total_weight)
    substantial = [code for code, count in weights.items() if count / total >= 0.20]
    if len(substantial) > 1:
        return "multilingual"
    return weights.most_common(1)[0][0]


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
                    # Embedded subtitle tracks may be translated or belong to another
                    # language stream; without Whisper verification they are not burned in.
                    "captionable": False,
                    "languageValidated": False,
                    "unverified": True,
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
            shifted_word = dict(w)
            shifted_word["start"] = round(float(w["start"]) + offset_sec, 3)
            shifted_word["end"] = round(float(w["end"]) + offset_sec, 3)
            words.append(shifted_word)
        copied = dict(seg)
        copied.update(
            {
                "id": seg.get("id", 0),
                "start": g_start,
                "end": g_end,
                "text": seg.get("text", ""),
                "words": words,
            }
        )
        shifted.append(copied)
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

        norm_txt = re.sub(r"[^\w]+", " ", str(seg.get("text") or "").lower(), flags=re.UNICODE).strip()
        is_dup = False
        for prev in tail_window:
            if _segment_iou(s_t, e_t, float(prev["start"]), float(prev["end"])) > 0.42:
                is_dup = True
                break
            prev_txt = re.sub(r"[^\w]+", " ", str(prev.get("text") or "").lower(), flags=re.UNICODE).strip()
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


def _load_whisper_model(
    model_name: str, device: str, compute_type: str, local_files_only: bool
) -> Optional[Any]:
    cache_key = (model_name, device or "cpu", compute_type or "int8")
    if cache_key in _WHISPER_UNAVAILABLE_KEYS:
        return None
    model = _CACHED_WHISPER_MODELS.get(cache_key)
    if model is not None:
        return model
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            model_name,
            device=cache_key[1],
            compute_type=cache_key[2],
            local_files_only=local_files_only,
        )
        _CACHED_WHISPER_MODELS[cache_key] = model
        return model
    except Exception:
        _WHISPER_UNAVAILABLE_KEYS.add(cache_key)
        return None


def _decode_whisper(
    model: Any, wav_path: str, forced_language: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], Any]:
    """Decode verbatim speech (never translation) with VAD padding and word alignment."""
    seg_iter, info = model.transcribe(
        wav_path,
        language=forced_language,
        task="transcribe",
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 250},
        beam_size=5,
        temperature=0.0,
        condition_on_previous_text=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
    )
    segments: List[Dict[str, Any]] = []
    for idx, seg in enumerate(seg_iter):
        text = (getattr(seg, "text", "") or "").strip()
        start = max(0.0, float(getattr(seg, "start", 0.0)))
        end = max(start, float(getattr(seg, "end", start)))
        if not text or end <= start:
            continue
        words: List[Dict[str, Any]] = []
        for word in getattr(seg, "words", None) or []:
            token = (getattr(word, "word", "") or "").strip()
            try:
                word_start = max(start, min(end, float(word.start)))
                word_end = max(word_start, min(end, float(word.end)))
            except (TypeError, ValueError, AttributeError):
                continue
            if not token or word_end <= word_start:
                continue
            try:
                probability = max(0.0, min(1.0, float(getattr(word, "probability", 0.9))))
            except (TypeError, ValueError):
                probability = 0.9
            words.append(
                {
                    "word": token,
                    "start": round(word_start, 3),
                    "end": round(word_end, 3),
                    "probability": round(probability, 3),
                }
            )
        if not words:
            words = _interpolate_words(text, start, end)
        segments.append(
            {
                "id": idx,
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "words": words,
            }
        )
    return segments, info


def _whisper_language(info: Any, text: str) -> Tuple[str, float]:
    detected = _normalize_language(getattr(info, "language", None))
    if not detected:
        detected = _infer_transcript_language(text) or "und"
    try:
        confidence = max(0.0, min(1.0, float(getattr(info, "language_probability", 1.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    return detected, confidence


def _text_supports_language(language: str, text: str) -> bool:
    counts = _script_counts(text)
    if language in {"hi", "mr", "ne", "sa"}:
        return counts["hi"] >= 3 or _latin_language_hints(text)[0] >= 2
    if language in {"ar", "fa", "ur"}:
        return counts["ar"] >= 3
    if language in {"bn", "pa", "ru", "ta", "te", "kn", "ml", "gu", "th"}:
        return counts[language] >= 3
    if language == "en":
        _, english_hits = _latin_language_hints(text)
        return counts["latin"] >= 4 and (english_hits >= 2 or _strong_english_hits(text) >= 1)
    return bool(text.strip())


def _text_matches_expected_language(
    language: str,
    text: str,
    allowed_languages: Optional[List[str]] = None,
    expected_profile: str = "",
) -> bool:
    """Validate a chunk against the language detected across the complete audio."""
    expected = _normalize_language(language)
    if not expected or not str(text or "").strip():
        return False

    allowed = {
        code
        for code in (_normalize_language(item) for item in (allowed_languages or [expected]))
        if code
    }
    allowed.add(expected)
    counts = _script_counts(text)
    mixed_global_profile = (
        expected_profile in {"hinglish", "multilingual"}
        and {"hi", "en"}.issubset(allowed)
    )
    inferred = _infer_transcript_language(text, expected)
    compatible_families = {
        "hi": {"hi", "mr", "ne", "sa"},
        "ar": {"ar", "ur", "fa"},
    }
    if inferred:
        compatible_codes = compatible_families.get(inferred, {inferred})
        if not compatible_codes.intersection(allowed):
            return False

    for code in allowed:
        if code == "en":
            # English has no unique Unicode script. The full-audio decision supplies
            # the language identity; require Latin speech text and let script checks
            # above reject Hindi/Arabic/other-script output.
            supports_language = counts["latin"] >= 4
        else:
            supports_language = _text_supports_language(code, text)
        if not supports_language:
            continue
        if code == "hi" and not mixed_global_profile:
            # Hindi-only captions should be in Devanagari. Romanized Hindi is
            # allowed only when the full-audio probe found both Hindi and English.
            if counts["hi"] < 3:
                continue
        return True

    return False


def _try_faster_whisper(
    wav_path: str,
    model_size: str,
    model_path: str,
    device: str,
    compute_type: str,
    language: str,
    expected_language: Optional[str] = None,
    expected_languages: Optional[List[str]] = None,
    expected_language_profile: str = "",
) -> Optional[Dict[str, Any]]:
    local_only = bool(model_path and os.path.isdir(model_path))
    target_model = model_path if local_only else model_size
    # A named English-only checkpoint cannot auto-detect Hindi, Arabic, or code
    # switching. Prefer its multilingual sibling when weights are downloaded by id.
    if not local_only and target_model.lower().endswith(".en"):
        target_model = target_model[:-3]
    model = _load_whisper_model(target_model, device, compute_type, local_only)
    if model is None:
        return None

    expected = _normalize_language(expected_language)
    try:
        # The full-audio preflight supplies a stable forced language for every
        # chunk. Without it (e.g. standalone clip regeneration), Whisper starts
        # with automatic detection and validates its own result.
        first_segments, first_info = _decode_whisper(
            model, wav_path, forced_language=expected
        )
    except Exception:
        return None

    first_text = " ".join(segment["text"] for segment in first_segments).strip()
    first_language, first_confidence = _whisper_language(first_info, first_text)
    if expected:
        first_matches_expected = _text_matches_expected_language(
            expected, first_text, expected_languages, expected_language_profile
        )
        retry_target = expected if not first_matches_expected else None
    else:
        retry_target = _language_conflict(first_language, first_text)
        language_hint = _normalize_language(language)
        if not retry_target and first_language == "und" and language_hint:
            retry_target = language_hint

    chosen_segments = first_segments
    chosen_language = expected or first_language
    chosen_confidence = first_confidence
    retried = False
    validation_conflict = (
        not first_matches_expected if expected else bool(retry_target)
    )

    if retry_target:
        retry_model = model
        # English-only Whisper variants cannot recover a Hindi/Arabic retry.
        if target_model.lower().endswith(".en") and retry_target != "en" and not local_only:
            retry_model = _load_whisper_model(
                target_model[:-3], device, compute_type, local_files_only=False
            ) or model
        try:
            retry_segments, retry_info = _decode_whisper(
                retry_model, wav_path, forced_language=retry_target
            )
            retried = True
            retry_text = " ".join(segment["text"] for segment in retry_segments).strip()
            retry_language, retry_confidence = _whisper_language(retry_info, retry_text)
            if expected:
                retry_matches_expected = _text_matches_expected_language(
                    expected, retry_text, expected_languages, expected_language_profile
                )
                validation_conflict = not retry_matches_expected
                chosen_language = expected
            else:
                # A forced decode can still be wrong; only trust it when its
                # detected language agrees with the transcript's script/content.
                remaining_conflict = _language_conflict(retry_language, retry_text)
                validation_conflict = bool(remaining_conflict)
                chosen_language = retry_language
            if retry_segments:
                chosen_segments = retry_segments
                chosen_confidence = retry_confidence
            else:
                # An empty retry cannot validate the original conflicting transcript.
                validation_conflict = True
        except Exception:
            validation_conflict = True

    full_text = " ".join(segment["text"] for segment in chosen_segments).strip()
    if expected:
        validation_conflict = not _text_matches_expected_language(
            expected, full_text, expected_languages, expected_language_profile
        )
    validated = bool(chosen_segments and chosen_language != "und" and not validation_conflict)
    if not expected and validated and chosen_confidence < 0.20 and not _text_supports_language(
        chosen_language, full_text
    ):
        validated = False

    full_text = " ".join(segment["text"] for segment in chosen_segments).strip()
    profile = _language_profile(full_text, chosen_language)
    for segment in chosen_segments:
        segment["language"] = chosen_language
        segment["languageProfile"] = profile
        segment["languageValidated"] = validated
        segment["captionable"] = validated

    return {
        "segments": chosen_segments,
        "modelName": target_model,
        "detectedLanguage": chosen_language,
        "languageProbability": chosen_confidence,
        "languageProfile": profile,
        "languageValidated": validated,
        "retried": retried,
        "initialDetectedLanguage": first_language,
        "retryLanguage": retry_target if retried else None,
    }


def _aggregate_language_observations(
    observations: List[Dict[str, Any]], total_windows: int
) -> Dict[str, Any]:
    if not observations:
        return {
            "language": "und",
            "languageProfile": "und",
            "allowedLanguages": [],
            "languageConfidence": 0.0,
            "languageValidated": False,
            "sampleCount": 0,
            "sampleWindows": total_windows,
        }

    label_scores: Counter = Counter()
    profile_scores: Counter = Counter()
    total_score = 0.0
    confidence_sum = 0.0
    for observation in observations:
        text = str(observation.get("text") or "")
        confidence = max(0.0, min(1.0, float(observation.get("confidence", 0.0))))
        text_weight = max(0.25, min(1.0, len(text) / 80.0))
        weight = confidence * text_weight
        language = _normalize_language(observation.get("language"))
        if not language or weight <= 0.0:
            continue
        label_scores[language] += weight
        profile = str(observation.get("profile") or language)
        profile_scores[profile] += weight
        total_score += weight
        confidence_sum += confidence * text_weight

    if not label_scores or total_score <= 0.0:
        return {
            "language": "und",
            "languageProfile": "und",
            "allowedLanguages": [],
            "languageConfidence": 0.0,
            "languageValidated": False,
            "sampleCount": 0,
            "sampleWindows": total_windows,
        }

    dominant_language, dominant_score = label_scores.most_common(1)[0]
    label_share = dominant_score / total_score
    language_profile = dominant_language
    if profile_scores.get("hinglish", 0.0) / total_score >= 0.20:
        language_profile = "hinglish"
    else:
        substantial = [
            code for code, score in label_scores.items() if score / total_score >= 0.35
        ]
        if profile_scores.get("multilingual", 0.0) / total_score >= 0.20 or len(substantial) > 1:
            language_profile = "multilingual"

    # Whisper has no single Hinglish language token. Use Hindi as the stable
    # decoding language so Hindi words render in Devanagari while English words
    # remain English; validation permits either language within that profile.
    primary_language = "hi" if language_profile == "hinglish" else dominant_language
    allowed_languages = {
        code for code, score in label_scores.items() if score / total_score >= 0.35
    }
    if language_profile == "hinglish":
        allowed_languages.update({"hi", "en"})
    for observation in observations:
        if observation.get("profile") != "multilingual":
            continue
        text = str(observation.get("text") or "")
        counts = _script_counts(text)
        if counts["ar"] >= 3:
            allowed_languages.add("ar")
        if counts["hi"] >= 3:
            allowed_languages.add("hi")
        if counts["latin"] >= 4 and (
            _latin_language_hints(text)[1] >= 1 or _strong_english_hits(text) >= 1
        ):
            allowed_languages.add("en")

    coverage = min(1.0, len(observations) / float(max(1, total_windows)))
    mean_confidence = confidence_sum / max(0.001, sum(
        max(0.25, min(1.0, len(str(item.get("text") or "")) / 80.0))
        for item in observations
    ))
    consensus = 1.0 if language_profile in {"hinglish", "multilingual"} else label_share
    confidence = max(0.0, min(1.0, mean_confidence * coverage * consensus))
    return {
        "language": primary_language,
        "languageProfile": language_profile,
        "allowedLanguages": sorted(allowed_languages or {primary_language}),
        "languageConfidence": round(confidence, 4),
        "languageValidated": confidence >= 0.50,
        "sampleCount": len(observations),
        "sampleWindows": total_windows,
    }


def whisper_model_available(
    model_size: str, model_path: str, device: str, compute_type: str
) -> bool:
    """Load/cache the configured model before the full-audio language probe."""
    local_only = bool(model_path and os.path.isdir(model_path))
    target_model = model_path if local_only else model_size
    if not local_only and target_model.lower().endswith(".en"):
        target_model = target_model[:-3]
    return _load_whisper_model(target_model, device, compute_type, local_only) is not None


def detect_full_audio_language(
    sample_wav_paths: List[str],
    model_size: str,
    model_path: str,
    device: str,
    compute_type: str,
    language_hint: str = "auto",
) -> Dict[str, Any]:
    """Detect one stable language from evenly sampled windows across the full audio."""
    observations: List[Dict[str, Any]] = []
    by_path: Dict[str, Dict[str, Any]] = {}
    for wav_path in sample_wav_paths:
        result = _try_faster_whisper(
            wav_path=wav_path,
            model_size=model_size,
            model_path=model_path,
            device=device,
            compute_type=compute_type,
            language=language_hint,
        )
        text = " ".join(
            str(segment.get("text") or "") for segment in (result or {}).get("segments", [])
        ).strip()
        language = _normalize_language((result or {}).get("detectedLanguage"))
        if (
            result
            and result.get("languageValidated")
            and language
            and text
        ):
            observation = {
                "path": wav_path,
                "language": language,
                "profile": str(result.get("languageProfile") or language),
                "confidence": float(result.get("languageProbability", 0.0)),
                "text": text,
            }
            observations.append(observation)
            by_path[wav_path] = observation

    detection = _aggregate_language_observations(observations, len(sample_wav_paths))
    if detection["language"] != "und":
        retry_count = 0
        allowed = detection["allowedLanguages"]
        primary = detection["language"]
        profile = detection["languageProfile"]
        # Recheck low-confidence or outlier windows using the full-audio decision.
        # This prevents one short chunk's script guess from setting the whole job's
        # caption language, while retaining supported Hindi-English code-switching.
        for wav_path in sample_wav_paths:
            previous = by_path.get(wav_path)
            if previous and previous["language"] in allowed and detection["languageConfidence"] >= 0.65:
                continue
            retry = _try_faster_whisper(
                wav_path=wav_path,
                model_size=model_size,
                model_path=model_path,
                device=device,
                compute_type=compute_type,
                language=language_hint,
                expected_language=primary,
                expected_languages=allowed,
                expected_language_profile=profile,
            )
            retry_text = " ".join(
                str(segment.get("text") or "") for segment in (retry or {}).get("segments", [])
            ).strip()
            if retry and retry.get("languageValidated") and retry_text:
                retry_count += 1
                by_path[wav_path] = {
                    "path": wav_path,
                    "language": primary,
                    "profile": profile if profile in {"hinglish", "multilingual"} else str(retry.get("languageProfile") or profile),
                    "confidence": float(retry.get("languageProbability", 0.0)),
                    "text": retry_text,
                }
            else:
                by_path.pop(wav_path, None)

        observations = list(by_path.values())
        detection = _aggregate_language_observations(observations, len(sample_wav_paths))
        detection["retryCount"] = retry_count

    hint = _normalize_language(language_hint)
    if hint and not detection["languageValidated"] and sample_wav_paths:
        hinted_observations: List[Dict[str, Any]] = []
        for wav_path in sample_wav_paths:
            retry = _try_faster_whisper(
                wav_path=wav_path,
                model_size=model_size,
                model_path=model_path,
                device=device,
                compute_type=compute_type,
                language=language_hint,
                expected_language=hint,
                expected_languages=[hint],
            )
            retry_text = " ".join(
                str(segment.get("text") or "") for segment in (retry or {}).get("segments", [])
            ).strip()
            if retry and retry.get("languageValidated") and retry_text:
                hinted_observations.append(
                    {
                        "language": hint,
                        "profile": str(retry.get("languageProfile") or hint),
                        "confidence": float(retry.get("languageProbability", 0.0)),
                        "text": retry_text,
                    }
                )
        hinted_detection = _aggregate_language_observations(
            hinted_observations, len(sample_wav_paths)
        )
        if hinted_detection["languageValidated"]:
            hinted_detection["retryCount"] = len(hinted_observations)
            hinted_detection["usedLanguageHint"] = True
            detection = hinted_detection

    detection.setdefault("retryCount", 0)
    detection["languageValidated"] = bool(detection["languageValidated"])
    return detection


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
    """Find speech-like windows for editing only; these are not transcripts or captions."""
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

    def window_segment(index: int, start: float, end: float) -> Dict[str, Any]:
        return {
            "id": index,
            "start": round(start, 2),
            "end": round(end, 2),
            "text": "",
            "words": [],
            "synthetic": True,
            "captionable": False,
            "languageValidated": False,
        }

    if not rms_vals:
        return [window_segment(0, 0.0, min(duration_sec, 15.0))]

    median_rms = float(np.median(rms_vals))
    thresh = max(0.005, median_rms * 0.65)
    segments: List[Dict[str, Any]] = []
    cur_start: Optional[float] = None

    for idx, val in enumerate(rms_vals):
        t = idx * 0.5
        if val >= thresh and cur_start is None:
            cur_start = t
        elif (val < thresh or t - (cur_start or 0.0) >= 8.5) and cur_start is not None:
            if t - cur_start >= 1.5:
                segments.append(window_segment(len(segments), cur_start, min(duration_sec, t)))
            cur_start = None

    if cur_start is not None and duration_sec - cur_start >= 1.0:
        segments.append(window_segment(len(segments), cur_start, duration_sec))

    if not segments:
        step = min(15.0, max(3.0, duration_sec / 3.0))
        t = 0.0
        while t < duration_sec - 0.5 and len(segments) < 12:
            end_t = round(min(duration_sec, t + step), 2)
            segments.append(window_segment(len(segments), t, end_t))
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
    expected_language: Optional[str] = None,
    expected_languages: Optional[List[str]] = None,
    expected_language_profile: str = "",
    global_language_confidence: float = 0.0,
    global_language_validated: bool = False,
    require_global_language_validation: bool = False,
) -> Dict[str, Any]:
    """
    Transcribes a bounded window in Whisper's transcription mode. The full-audio
    language decision, when provided, is used consistently and checked against the
    output script before captions are allowed.
    """
    warnings: List[str] = []
    chunk_dur = max(0.5, win_end - win_start)

    whisper_result = _try_faster_whisper(
        wav_path=wav_path,
        model_size=whisper_model_size,
        model_path=whisper_model_path,
        device=whisper_device,
        compute_type=whisper_compute_type,
        language=language,
        expected_language=expected_language,
        expected_languages=expected_languages,
        expected_language_profile=expected_language_profile,
    )
    if whisper_result is not None:
        if whisper_result["retried"]:
            retry_language = whisper_result.get("retryLanguage") or expected_language or "auto"
            warnings.append(
                "Whisper language validation detected a transcript/script conflict; "
                f"the chunk was retried using {retry_language}."
            )
        global_gate = not require_global_language_validation or global_language_validated
        captions_validated = bool(whisper_result["languageValidated"] and global_gate)
        if require_global_language_validation and not global_language_validated:
            warnings.append(
                "Full-audio language detection did not meet the confidence threshold; "
                "captions are suppressed rather than guessing a script."
            )
        elif not captions_validated:
            warnings.append(
                "Whisper output did not match the full-audio language after retry; "
                "captions are suppressed for this chunk."
            )

        decode_mode = f"full-audio={expected_language}" if expected_language else "auto-detect"
        result_language = (
            expected_language
            if require_global_language_validation and global_language_validated
            else whisper_result["detectedLanguage"]
        )
        result_profile = expected_language_profile or whisper_result["languageProfile"]
        shifted_segments = shift_segments_to_global(whisper_result["segments"], win_start)
        for segment in shifted_segments:
            segment["language"] = result_language
            segment["languageProfile"] = result_profile
            segment["languageValidated"] = captions_validated
            segment["captionable"] = captions_validated
            segment["globalLanguageConfidence"] = global_language_confidence
        return {
            "engine": "faster-whisper",
            "whisperStatus": f"faster-whisper ({whisper_result.get('modelName', whisper_model_size)}; {decode_mode})",
            "detectedLanguage": result_language,
            "languageProfile": result_profile,
            "languageProbability": whisper_result["languageProbability"],
            "globalLanguageConfidence": global_language_confidence,
            "languageValidated": captions_validated,
            "segments": shifted_segments,
            "warnings": warnings,
        }

    warnings.append(
        "Faster-Whisper could not be initialized or transcribe this chunk. "
        "Fallback transcript sources are unverified and will not be burned in as captions. "
        "Configure a multilingual Faster-Whisper model in WHISPER_MODEL_PATH or allow model download."
    )

    # Embedded subtitles may be translated or come from another subtitle stream, so
    # retain them for clip analysis but never claim they match the spoken audio.
    if embedded_global_segments is not None:
        sliced = []
        for segment in embedded_global_segments:
            if float(segment["end"]) > win_start and float(segment["start"]) < win_end:
                copied = dict(segment)
                copied.update(
                    {"captionable": False, "languageValidated": False, "unverified": True}
                )
                sliced.append(copied)
        return {
            "engine": "embedded_subtitles",
            "whisperStatus": "embedded_subtitles (unverified spoken language)",
            "detectedLanguage": "und",
            "languageProfile": "und",
            "languageValidated": False,
            "segments": sliced,
            "warnings": warnings,
        }

    # PocketSphinx's bundled English acoustic model is not suitable for Hindi,
    # Arabic, or multilingual audio. Keep its text as an analysis hint only.
    if chunk_dur <= 180.0:
        try:
            ps_segments = _try_pocketsphinx_offline(wav_path)
            if ps_segments:
                for segment in ps_segments:
                    segment.update(
                        {"captionable": False, "languageValidated": False, "unverified": True}
                    )
                return {
                    "engine": "pocketsphinx_offline",
                    "whisperStatus": "pocketsphinx_offline (unverified language)",
                    "detectedLanguage": "und",
                    "languageProfile": "und",
                    "languageValidated": False,
                    "segments": shift_segments_to_global(ps_segments, win_start),
                    "warnings": warnings,
                }
        except Exception as exc:
            warnings.append(f"PocketSphinx offline fallback warning: {exc}")

    local_vad = _build_acoustic_vad_segments_streaming(wav_path, chunk_dur, win_start)
    return {
        "engine": "acoustic_vad_segments",
        "whisperStatus": "acoustic_vad (no verified transcript)",
        "detectedLanguage": "und",
        "languageProfile": "und",
        "languageValidated": False,
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
