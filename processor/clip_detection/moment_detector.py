import json
import math
import urllib.request
from typing import Any, Dict, List


CATEGORY_CUES = {
    "hook": ["secret", "mistake", "never", "stop", "truth", "biggest", "first", "here is why", "imagine"],
    "educational": ["how to", "step", "because", "framework", "method", "explain", "lesson", "example", "process"],
    "insight": ["realized", "key", "important", "strategy", "growth", "data", "principle", "fundamental"],
    "surprising": ["actually", "surprising", "shocking", "unexpected", "nobody", "turns out", "myth"],
    "emotional": ["feel", "story", "struggle", "honest", "hardest", "grateful", "changed", "fear"],
    "funny": ["funny", "laugh", "hilarious", "joke", "crazy", "wild"],
    "discussion": ["question", "agree", "disagree", "perspective", "debate", "point"],
}


def _classify_text(text: str) -> str:
    lower = text.lower()
    best_cat = "insight"
    best_hits = 0
    for cat, cues in CATEGORY_CUES.items():
        hits = sum(1 for c in cues if c in lower)
        if hits > best_hits:
            best_hits = hits
            best_cat = cat
    if "?" in text and best_hits == 0:
        return "discussion"
    return best_cat


def _ends_sentence(text: str) -> bool:
    return bool((text or "").rstrip().endswith((".", "!", "?", "؟", "۔", "।", "॥", "…")))


def _is_verified_text_segment(segment: Dict[str, Any]) -> bool:
    return bool(
        str(segment.get("text") or "").strip()
        and segment.get("languageValidated", True)
        and not segment.get("unverified", False)
        and not segment.get("synthetic", False)
    )


def _trusted_text_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Text safe to send to a moment-scoring provider as a verified transcript."""
    return [segment for segment in segments if _is_verified_text_segment(segment)]


def _analysis_text_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Text that can inform internal ranking without being treated as verified speech."""
    return [
        segment
        for segment in segments
        if str(segment.get("text") or "").strip() and not segment.get("synthetic", False)
    ]


def _split_long_segments_for_moments(
    segments: List[Dict[str, Any]], max_dur: float
) -> List[Dict[str, Any]]:
    """Split unusually long ASR segments only at Whisper word/sentence boundaries."""
    prepared: List[Dict[str, Any]] = []
    for segment in segments:
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))
        words = sorted(segment.get("words") or [], key=lambda word: float(word.get("start", start)))
        if end - start <= max_dur or not words:
            prepared.append(segment)
            continue

        group: List[Dict[str, Any]] = []

        def flush_group() -> None:
            if not group:
                return
            copied = dict(segment)
            copied["start"] = float(group[0].get("start", start))
            copied["end"] = float(group[-1].get("end", end))
            copied["words"] = list(group)
            copied["text"] = " ".join(str(word.get("word") or "").strip() for word in group).strip()
            copied["id"] = len(prepared)
            prepared.append(copied)
            group.clear()

        for word in words:
            if group:
                previous_end = float(group[-1].get("end", start))
                word_start = float(word.get("start", previous_end))
                group_duration = float(group[-1].get("end", word_start)) - float(group[0].get("start", start))
                if word_start - previous_end >= 1.0 or group_duration >= max_dur:
                    flush_group()
            group.append(word)
            token = str(word.get("word") or "")
            group_duration = float(group[-1].get("end", start)) - float(group[0].get("start", start))
            if _ends_sentence(token) or group_duration >= max_dur:
                flush_group()
        flush_group()
    return prepared


def _snap_to_spoken_boundaries(
    start_sec: float,
    end_sec: float,
    segments: List[Dict[str, Any]],
    duration_sec: float,
) -> tuple:
    """Expand an AI-proposed interval to whole transcript/word boundaries plus a breath."""
    overlapping = [
        segment
        for segment in segments
        if float(segment.get("end", 0.0)) > start_sec
        and float(segment.get("start", 0.0)) < end_sec
    ]
    if not overlapping:
        return None
    overlapping.sort(key=lambda segment: (float(segment["start"]), float(segment["end"])))
    first, last = overlapping[0], overlapping[-1]
    first_words = first.get("words") or []
    last_words = last.get("words") or []
    start_edge = min(
        float(first.get("start", start_sec)),
        min((float(word.get("start", start_sec)) for word in first_words), default=start_sec),
    )
    end_edge = max(
        float(last.get("end", end_sec)),
        max((float(word.get("end", end_sec)) for word in last_words), default=end_sec),
    )
    # A short breath of context protects the first and last phonemes without
    # moving the candidate onto an unrelated neighboring sentence.
    return max(0.0, start_edge - 0.12), min(duration_sec, end_edge + 0.18)


def _has_complete_speech_boundaries(
    start_sec: float,
    end_sec: float,
    segments: List[Dict[str, Any]],
    duration_sec: float,
) -> bool:
    """Require a natural start and end: sentence boundary, pause, or media end."""
    ordered = sorted(
        segments,
        key=lambda segment: (float(segment.get("start", 0.0)), float(segment.get("end", 0.0))),
    )
    overlapping_indices = [
        index
        for index, segment in enumerate(ordered)
        if float(segment.get("end", 0.0)) > start_sec
        and float(segment.get("start", 0.0)) < end_sec
    ]
    if not overlapping_indices:
        return False

    first_index = overlapping_indices[0]
    last_index = overlapping_indices[-1]
    first = ordered[first_index]
    last = ordered[last_index]
    starts_cleanly = first_index == 0
    if first_index > 0:
        previous = ordered[first_index - 1]
        pause = float(first.get("start", 0.0)) - float(previous.get("end", 0.0))
        starts_cleanly = _ends_sentence(str(previous.get("text") or "")) or pause >= 0.8

    ends_cleanly = _ends_sentence(str(last.get("text") or ""))
    if last_index + 1 < len(ordered):
        following = ordered[last_index + 1]
        pause = float(following.get("start", end_sec)) - float(last.get("end", end_sec))
        ends_cleanly = ends_cleanly or pause >= 0.8
    else:
        ends_cleanly = ends_cleanly or end_sec >= duration_sec - 1.0

    return starts_cleanly and ends_cleanly


def _moment_context_features(
    start_sec: float,
    end_sec: float,
    scenes: List[Dict[str, Any]],
    energy_timeline: List[Dict[str, float]],
) -> Dict[str, Any]:
    energy_values = [
        float(point.get("rms", 0.0))
        for point in energy_timeline
        if start_sec <= float(point.get("t", -1.0)) <= end_sec
    ]
    mean_rms = sum(energy_values) / len(energy_values) if energy_values else 0.0
    overlapping_scenes = [
        scene
        for scene in scenes
        if scene.get("analysisAvailable", True)
        and float(scene.get("end", 0.0)) > start_sec
        and float(scene.get("start", 0.0)) < end_sec
    ]
    has_face = any(scene.get("hasFace") for scene in overlapping_scenes)
    motion_bonus = (
        sum(float(scene.get("motionScore", 0.0)) for scene in overlapping_scenes)
        / len(overlapping_scenes)
        * 10.0
        if overlapping_scenes
        else 0.0
    )
    visual_score = (
        sum(float(scene.get("score", 0.0)) for scene in overlapping_scenes)
        / len(overlapping_scenes)
        if overlapping_scenes
        else 0.0
    )
    return {
        "audioEnergy": round(mean_rms, 5),
        "visualScore": round(visual_score, 3),
        "energyBonus": min(15.0, mean_rms * 180.0),
        "motionBonus": motion_bonus,
        "hasFace": has_face,
    }


def _build_moment_prompt(
    segments: List[Dict[str, Any]],
    min_dur: float,
    max_dur: float,
    clip_count: int,
) -> str:
    compact = [
        {"start": s["start"], "end": s["end"], "text": s["text"]}
        for s in segments[:140]
    ]
    return (
        f"Select up to {clip_count + 2} non-overlapping complete-thought video clip moments "
        f"between {min_dur}s and {max_dur}s from these global-timestamped transcript segments. "
        "Return global timestamps aligned to the provided transcript/word boundaries; include the full first and last spoken sentence and never cut mid-word. "
        "Do not rewrite, translate, or return transcript text; select moments only. "
        "Return a JSON array (or object with key 'moments') of items with keys: "
        "startSec, endSec, title, category (hook|educational|insight|surprising|emotional|funny|discussion), "
        "reason, engagementScore (50-95).\nSegments:\n" + json.dumps(compact)
    )


def _try_gemini_moment_scoring(
    segments: List[Dict[str, Any]],
    gemini_api_key: str,
    gemini_model: str,
    min_dur: float,
    max_dur: float,
    clip_count: int,
) -> List[Dict[str, Any]]:
    if not gemini_api_key or len(gemini_api_key.strip()) < 10 or not segments:
        return []

    prompt = _build_moment_prompt(segments, min_dur, max_dur, clip_count)
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{gemini_model}:generateContent"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
            }
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": gemini_api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        txt = payload["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(txt)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict) and isinstance(parsed.get("moments"), list):
            return parsed["moments"]
    except Exception:
        return []
    return []


def _try_openai_moment_scoring(
    segments: List[Dict[str, Any]],
    openai_api_key: str,
    openai_base_url: str,
    openai_model: str,
    min_dur: float,
    max_dur: float,
    clip_count: int,
) -> List[Dict[str, Any]]:
    if not openai_api_key or len(openai_api_key.strip()) < 8 or not segments:
        return []

    prompt = _build_moment_prompt(segments, min_dur, max_dur, clip_count)
    url = f"{openai_base_url.rstrip('/')}/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "model": openai_model or "gpt-4o-mini",
                "response_format": {"type": "json_object"},
                "temperature": 0.3,
                "messages": [
                    {
                        "role": "system",
                        "content": "Return JSON object {\"moments\": [...]} with engaging short-form video moments.",
                    },
                    {"role": "user", "content": prompt},
                ],
            }
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {openai_api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        txt = payload["choices"][0]["message"]["content"]
        parsed = json.loads(txt)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict) and isinstance(parsed.get("moments"), list):
            return parsed["moments"]
    except Exception:
        return []
    return []


def detect_candidate_moments(
    segments: List[Dict[str, Any]],
    scenes: List[Dict[str, Any]],
    energy_timeline: List[Dict[str, float]],
    duration_sec: float,
    min_dur: float,
    max_dur: float,
    clip_count: int,
    ai_provider: str = "gemini",
    gemini_api_key: str = "",
    gemini_model: str = "gemini-2.5-flash",
    openai_api_key: str = "",
    openai_base_url: str = "https://api.openai.com/v1",
    openai_model: str = "gpt-4o-mini",
    window_start_sec: float = 0.0,
    window_end_sec: float = 0.0,
) -> Dict[str, Any]:
    effective_window_end = window_end_sec if window_end_sec > window_start_sec else duration_sec
    window_span = max(1.0, effective_window_end - window_start_sec)

    effective_max = min(max_dur, duration_sec, max(max_dur, window_span))
    effective_min = min(min_dur, max(3.0, duration_sec / max(1.0, clip_count + 0.5)))
    if effective_max < effective_min:
        effective_max = min(duration_sec, max(effective_min, window_span))

    # Unverified embedded subtitles or fallback ASR may inform internal moment
    # ranking, but only globally verified transcript segments are sent to a
    # scoring provider or described as verified speech.
    segments_for_moments = _split_long_segments_for_moments(
        _analysis_text_segments(segments), effective_max
    )
    trusted_segments = _trusted_text_segments(segments_for_moments)
    if not trusted_segments:
        ai_candidates: List[Dict[str, Any]] = []
    elif ai_provider == "openai_compatible" and openai_api_key:
        ai_candidates = _try_openai_moment_scoring(
            trusted_segments,
            openai_api_key,
            openai_base_url,
            openai_model,
            effective_min,
            effective_max,
            clip_count,
        )
    else:
        ai_candidates = _try_gemini_moment_scoring(
            trusted_segments, gemini_api_key, gemini_model, effective_min, effective_max, clip_count
        )

    used_ai = len(ai_candidates) > 0
    candidates: List[Dict[str, Any]] = []

    if used_ai:
        for item in ai_candidates:
            if not isinstance(item, dict):
                continue
            try:
                raw_start = float(item.get("startSec", window_start_sec))
                raw_end = float(item.get("endSec", 0.0))
                raw_score = int(item.get("engagementScore", 82))
            except (TypeError, ValueError, OverflowError):
                continue
            if not all(math.isfinite(value) for value in (raw_start, raw_end, float(raw_score))):
                continue
            proposed_start = max(0.0, raw_start)
            proposed_end = min(duration_sec, raw_end)
            if proposed_end <= proposed_start:
                continue
            aligned = _snap_to_spoken_boundaries(
                proposed_start, proposed_end, trusted_segments, duration_sec
            )
            if not aligned:
                continue
            s_t, e_t = aligned
            if e_t - s_t < 2.5 or e_t - s_t > effective_max * 1.35:
                continue
            if not _has_complete_speech_boundaries(s_t, e_t, trusted_segments, duration_sec):
                continue
            seg_texts = [
                str(seg.get("text") or "").strip()
                for seg in trusted_segments
                if float(seg["end"]) > s_t and float(seg["start"]) < e_t
            ]
            context = _moment_context_features(s_t, e_t, scenes, energy_timeline)
            context_boost = min(
                8,
                int(round(context["energyBonus"] * 0.2 + context["motionBonus"] * 0.2))
                + (2 if context["hasFace"] else 0),
            )
            base_score = max(45, min(96, raw_score))
            candidates.append(
                {
                    "startSec": round(s_t, 2),
                    "endSec": round(e_t, 2),
                    "durationSec": round(e_t - s_t, 2),
                    "transcript": " ".join(seg_texts).strip(),
                    "title": str(item.get("title") or "AI Selected Highlight"),
                    "category": str(item.get("category") or "insight"),
                    "reason": str(item.get("reason") or "AI-selected complete engaging moment."),
                    "engagementScore": min(96, base_score + context_boost),
                    "completeThought": True,
                    "transcriptVerified": True,
                    "audioEnergy": context["audioEnergy"],
                    "visualScore": context["visualScore"],
                }
            )

    # Deterministic sentence-boundary + acoustic + visual moment scoring. Only
    # natural sentence/pause endings are eligible; incomplete windows are not promoted.
    n_segs = len(segments_for_moments)
    for i in range(n_segs):
        current = segments_for_moments[i]
        start_t = float(current.get("start", 0.0))
        if float(current.get("end", start_t)) <= start_t:
            continue

        # Avoid beginning on a continuation of the previous spoken sentence unless
        # there is a real pause that makes it a natural new moment.
        if i > 0:
            previous = segments_for_moments[i - 1]
            previous_text = str(previous.get("text") or "")
            pause = start_t - float(previous.get("end", start_t))
            if (
                not _ends_sentence(previous_text)
                and pause < 0.8
                and not previous.get("synthetic", False)
            ):
                continue

        start_words = current.get("words") or []
        safe_start = min(
            start_t,
            min((float(word.get("start", start_t)) for word in start_words), default=start_t),
        )
        candidate_options: List[tuple] = []
        gathered_texts: List[str] = []
        gathered_segments: List[Dict[str, Any]] = []

        for j in range(i, n_segs):
            last = segments_for_moments[j]
            end_t = float(last.get("end", start_t))
            if end_t <= start_t:
                continue
            span = end_t - start_t
            if span > effective_max * 1.35:
                break

            gathered_texts.append(str(last.get("text") or "").strip())
            gathered_segments.append(last)
            full_text = " ".join(text for text in gathered_texts if text).strip()
            if span < effective_min and j < n_segs - 1:
                continue

            last_words = last.get("words") or []
            safe_end = max(
                end_t,
                max((float(word.get("end", end_t)) for word in last_words), default=end_t),
            )
            candidate_start = max(0.0, safe_start - 0.12)
            candidate_end = min(duration_sec, safe_end + 0.18)
            span = candidate_end - candidate_start
            if span > effective_max * 1.35 and j > i:
                break

            next_pause = (
                float(segments_for_moments[j + 1].get("start", end_t)) - end_t
                if j + 1 < n_segs
                else 0.0
            )
            ends_cleanly = _ends_sentence(str(last.get("text") or "")) or (
                j + 1 < n_segs and next_pause >= 0.8
            ) or (j == n_segs - 1 and end_t >= duration_sec - 1.0)

            context = _moment_context_features(candidate_start, candidate_end, scenes, energy_timeline)
            energy_bonus = float(context["energyBonus"])
            motion_bonus = float(context["motionBonus"])
            has_face = bool(context["hasFace"])

            category = _classify_text(full_text)
            transcript_verified = bool(gathered_segments) and all(
                _is_verified_text_segment(segment) for segment in gathered_segments
            )
            sentence_bonus = 8.0 if ends_cleanly else 0.0
            hook_bonus = 7.0 if ("?" in full_text[:80] or "؟" in full_text[:80] or category in ("hook", "surprising")) else 3.0
            face_bonus = 6.0 if has_face else 0.0
            verification_adjustment = 4.0 if transcript_verified else -4.0
            raw_score = int(
                round(
                    54.0
                    + energy_bonus
                    + motion_bonus
                    + sentence_bonus
                    + hook_bonus
                    + face_bonus
                    + verification_adjustment
                )
            )
            score = max(50, min(95, raw_score))

            words_preview = [word for word in full_text.replace(".", "").split() if len(word) > 2][:6]
            suggested_title = (
                " ".join(words_preview).title()
                if words_preview
                else f"Highlight ({start_t:.0f}s)"
            )
            reason_parts = [f"Complete {category} segment" if ends_cleanly else f"Full spoken {category} window"]
            if has_face:
                reason_parts.append("active speaker face tracked")
            if energy_bonus > 6:
                reason_parts.append("strong vocal energy peak")

            candidate_options.append(
                (
                    {
                        "startSec": round(candidate_start, 2),
                        "endSec": round(candidate_end, 2),
                        "durationSec": round(span, 2),
                        "transcript": full_text,
                        "title": suggested_title[:90],
                        "category": category,
                        "reason": ", ".join(reason_parts).capitalize() + ".",
                        "engagementScore": score,
                        "completeThought": ends_cleanly,
                        "transcriptVerified": transcript_verified,
                        "audioEnergy": context["audioEnergy"],
                        "visualScore": context["visualScore"],
                    },
                    ends_cleanly,
                )
            )
            if ends_cleanly:
                break

        # Do not fall back to an incomplete speech window just to fill candidates.
        if candidate_options and candidate_options[-1][1]:
            candidates.append(candidate_options[-1][0])

    # Keep top candidates per chunk so checkpoint files remain compact even across 60+ chunks
    candidates.sort(key=lambda c: (c.get("engagementScore", 0), c.get("durationSec", 0)), reverse=True)
    return {"candidates": candidates[: max(12, clip_count * 4)], "usedAi": used_ai}
