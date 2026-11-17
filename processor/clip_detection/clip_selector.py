import re
from typing import Any, Dict, List, Optional, Set


def _temporal_overlap_ratio(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    if inter <= 0.0:
        return 0.0
    shortest = max(0.1, min(a_end - a_start, b_end - b_start))
    return inter / shortest


def _temporal_gap_sec(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    if a_end <= b_start:
        return b_start - a_end
    if b_end <= a_start:
        return a_start - b_end
    return 0.0


def _token_set(text: str) -> Set[str]:
    # Unicode-aware tokens keep seam de-duplication effective for Hindi, Arabic,
    # and other scripts instead of silently reducing them to an empty set.
    tokens = re.findall(r"[^\W_]{3,}", (text or "").lower(), flags=re.UNICODE)
    # Ignore generic fallback timestamp numbers so distinct chapters aren't collapsed
    return {t for t in tokens if not t.isdigit() and t not in {"active", "spoken", "segment", "media", "highlight"}}


def _is_lexical_near_duplicate(txt_a: str, txt_b: str) -> bool:
    set_a = _token_set(txt_a)
    set_b = _token_set(txt_b)
    if len(set_a) < 5 or len(set_b) < 5:
        return False
    inter = len(set_a & set_b)
    union = max(1, len(set_a | set_b))
    return (inter / union) > 0.72


def _ends_sentence(text: str) -> bool:
    return bool((text or "").rstrip().endswith((".", "!", "?", "؟", "۔", "।", "॥", "…")))


def _speech_aligned_fallbacks(
    segments: List[Dict[str, Any]], min_dur: float, max_dur: float, duration_sec: float
) -> List[Dict[str, Any]]:
    """Build extra candidates only from complete segment/word boundaries."""
    ordered = sorted(
        (segment for segment in segments if float(segment.get("end", 0.0)) > float(segment.get("start", 0.0))),
        key=lambda segment: float(segment["start"]),
    )
    results: List[Dict[str, Any]] = []
    for i, first in enumerate(ordered):
        first_start = float(first["start"])
        if i and not _ends_sentence(str(ordered[i - 1].get("text") or "")):
            pause = first_start - float(ordered[i - 1].get("end", first_start))
            if pause < 0.8 and not ordered[i - 1].get("synthetic", False):
                continue

        chosen: List[Dict[str, Any]] = []
        fallback_end = float(first["end"])
        for j in range(i, len(ordered)):
            segment = ordered[j]
            end = float(segment["end"])
            if end - first_start > max_dur and j > i:
                break
            chosen.append(segment)
            fallback_end = end
            next_pause = (
                float(ordered[j + 1].get("start", end)) - end if j + 1 < len(ordered) else 0.0
            )
            full_text = str(segment.get("text") or "")
            boundary = _ends_sentence(full_text) or next_pause >= 0.8 or j == len(ordered) - 1
            if end - first_start >= min_dur and boundary:
                break

        if not chosen:
            continue
        last = chosen[-1]
        first_words = first.get("words") or []
        last_words = last.get("words") or []
        start_edge = min(
            first_start,
            min((float(word.get("start", first_start)) for word in first_words), default=first_start),
        )
        end_edge = max(
            fallback_end,
            max((float(word.get("end", fallback_end)) for word in last_words), default=fallback_end),
        )
        start_sec = max(0.0, start_edge - 0.12)
        end_sec = min(duration_sec, end_edge + 0.18)
        if end_sec - start_sec < 1.5 or end_sec - start_sec > max_dur * 1.35:
            continue
        transcript = " ".join(
            str(segment.get("text") or "").strip()
            for segment in chosen
            if segment.get("languageValidated", True)
            and not segment.get("unverified", False)
            and not segment.get("synthetic", False)
        ).strip()
        results.append(
            {
                "startSec": round(start_sec, 2),
                "endSec": round(end_sec, 2),
                "durationSec": round(end_sec - start_sec, 2),
                "transcript": transcript,
                "title": f"Speech highlight ({start_sec:.0f}s)",
                "category": "insight",
                "reason": "Transcript-boundary fallback with complete spoken segment timing.",
                "engagementScore": 62,
            }
        )
    return results


def select_unique_clips(
    candidates: List[Dict[str, Any]],
    desired_count: int,
    duration_sec: float,
    min_dur: float = 15.0,
    max_dur: float = 30.0,
    segments: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Selects up to `desired_count` high-engagement clips across the full video timeline,
    eliminating temporal overlaps, chunk-boundary seam duplicates, and near-identical transcripts.
    """
    ranked = sorted(
        candidates,
        key=lambda c: (c.get("engagementScore", 0), c.get("durationSec", 0)),
        reverse=True,
    )

    min_gap = 3.0 if duration_sec >= 90.0 else 0.0
    selected: List[Dict[str, Any]] = []

    def _can_accept(cand: Dict[str, Any]) -> bool:
        c_s = float(cand["startSec"])
        c_e = float(cand["endSec"])
        if c_e - c_s < 1.5 or c_e > duration_sec + 0.5:
            return False
        for ex in selected:
            ex_s = float(ex["startSec"])
            ex_e = float(ex["endSec"])
            if _temporal_overlap_ratio(c_s, c_e, ex_s, ex_e) > 0.12:
                return False
            if min_gap > 0 and _temporal_gap_sec(c_s, c_e, ex_s, ex_e) < min_gap:
                return False
            if _is_lexical_near_duplicate(cand.get("transcript", ""), ex.get("transcript", "")):
                return False
        return True

    # For long-form videos (>= 20 min), ensure chapter diversity across the full timeline
    # before filling remaining slots globally by engagement score.
    if duration_sec >= 1200.0 and desired_count >= 2 and ranked:
        top_score = float(ranked[0].get("engagementScore", 0))
        bucket_span = duration_sec / float(desired_count)
        for b_idx in range(desired_count):
            b_start = b_idx * bucket_span
            b_end = (b_idx + 1) * bucket_span
            for cand in ranked:
                mid_t = 0.5 * (float(cand["startSec"]) + float(cand["endSec"]))
                if b_start <= mid_t <= b_end and float(cand.get("engagementScore", 0)) >= top_score - 15.0:
                    if _can_accept(cand):
                        selected.append(cand)
                        break

    for cand in ranked:
        if len(selected) >= desired_count:
            break
        if _can_accept(cand):
            selected.append(cand)

    # If transcript/speech timing exists, only fill missing slots with windows made
    # from complete segment boundaries. Never use evenly sliced windows through speech.
    if len(selected) < desired_count and segments:
        aligned_candidates = _speech_aligned_fallbacks(segments, min_dur, max_dur, duration_sec)
        aligned_candidates.sort(
            key=lambda candidate: (candidate.get("engagementScore", 0), candidate.get("durationSec", 0)),
            reverse=True,
        )
        for candidate in aligned_candidates:
            if len(selected) >= desired_count:
                break
            if _can_accept(candidate):
                selected.append(candidate)

    # Retain the old visual-only timeline fallback only when no transcript or
    # speech windows exist; in that case there is no speech boundary to cut off.
    if len(selected) < desired_count and not segments and duration_sec >= desired_count * 4.0:
        slice_stride = duration_sec / float(desired_count)
        target_len = min(max_dur, max(3.0, min(slice_stride * 0.85, max(min_dur, 20.0))))
        for idx in range(desired_count):
            if len(selected) >= desired_count:
                break
            s_t = round(idx * slice_stride, 2)
            e_t = round(min(duration_sec, s_t + target_len), 2)
            overlaps = any(
                _temporal_overlap_ratio(s_t, e_t, ex["startSec"], ex["endSec"]) > 0.15
                for ex in selected
            )
            if not overlaps and (e_t - s_t) >= 2.0:
                selected.append(
                    {
                        "startSec": s_t,
                        "endSec": e_t,
                        "durationSec": round(e_t - s_t, 2),
                        "transcript": "",
                        "title": f"Visual Highlight {idx + 1}",
                        "category": "insight",
                        "reason": "Visual-only timeline window; no speech timing was available.",
                        "engagementScore": 68,
                    }
                )

    return sorted(selected, key=lambda x: x["startSec"])
