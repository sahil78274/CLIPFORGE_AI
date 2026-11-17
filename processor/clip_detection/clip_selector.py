import math
import re
from typing import Any, Dict, List, Optional, Set


MIN_ENGAGEMENT_SCORE = 67
MIN_UNVERIFIED_ENGAGEMENT_SCORE = 70
MIN_TRANSCRIPT_TOKENS = 5


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
    return {
        token
        for token in tokens
        if not token.isdigit()
        and token not in {"active", "spoken", "segment", "media", "highlight"}
    }


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


def _transcript_token_count(text: str) -> int:
    return len(re.findall(r"[^\W_]+", text or "", flags=re.UNICODE))


def _has_complete_speech_boundaries(
    candidate: Dict[str, Any], segments: Optional[List[Dict[str, Any]]], duration_sec: float
) -> bool:
    explicit = candidate.get("completeThought")
    if explicit is not None:
        return bool(explicit)

    transcript = str(candidate.get("transcript") or "").strip()
    if _ends_sentence(transcript):
        return True
    if not segments:
        return False

    start_sec = float(candidate.get("startSec", 0.0))
    end_sec = float(candidate.get("endSec", 0.0))
    ordered = sorted(
        (
            segment
            for segment in segments
            if str(segment.get("text") or "").strip()
            and segment.get("languageValidated", True)
            and not segment.get("unverified", False)
            and not segment.get("synthetic", False)
        ),
        key=lambda segment: float(segment.get("start", 0.0)),
    )
    overlapping = [
        index
        for index, segment in enumerate(ordered)
        if float(segment.get("end", 0.0)) > start_sec
        and float(segment.get("start", 0.0)) < end_sec
    ]
    if not overlapping:
        return False

    first_index = overlapping[0]
    last_index = overlapping[-1]
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


def _silence_ratio(start_sec: float, end_sec: float, intervals: List[Dict[str, float]]) -> float:
    duration = max(0.1, end_sec - start_sec)
    silent_seconds = sum(
        max(0.0, min(end_sec, float(interval.get("end", 0.0))) - max(start_sec, float(interval.get("start", 0.0))))
        for interval in intervals
    )
    return min(1.0, silent_seconds / duration)


def select_unique_clips(
    candidates: List[Dict[str, Any]],
    desired_count: int,
    duration_sec: float,
    min_dur: float = 15.0,
    max_dur: float = 30.0,
    segments: Optional[List[Dict[str, Any]]] = None,
    silence_intervals: Optional[List[Dict[str, float]]] = None,
) -> List[Dict[str, Any]]:
    """Rank complete, transcript-supported moments without filling weak slots.

    Unverified transcript hints need a higher engagement score to qualify. This
    deliberately does not synthesize extra windows when there are too few suitable
    candidates: a short result is preferable to duplicated or weak clips.
    """
    requested = max(0, int(desired_count))
    if requested == 0:
        return []

    silence = silence_intervals or []
    max_candidate_duration = max_dur * 1.35
    min_candidate_duration = max(3.0, min_dur * 0.75)
    ranked: List[Dict[str, Any]] = []

    for candidate in candidates:
        try:
            start_sec = float(candidate["startSec"])
            end_sec = float(candidate["endSec"])
            score = float(candidate.get("engagementScore", 0))
        except (KeyError, TypeError, ValueError):
            continue

        transcript = str(candidate.get("transcript") or "").strip()
        candidate_duration = end_sec - start_sec
        if not all(math.isfinite(value) for value in (start_sec, end_sec, score, candidate_duration)):
            continue
        if start_sec < 0.0 or end_sec > duration_sec + 0.5:
            continue
        if candidate_duration < min_candidate_duration or candidate_duration > max_candidate_duration:
            continue
        if score < MIN_ENGAGEMENT_SCORE:
            continue
        if (
            candidate.get("transcriptVerified") is False
            and score < MIN_UNVERIFIED_ENGAGEMENT_SCORE
        ):
            continue
        if _transcript_token_count(transcript) < MIN_TRANSCRIPT_TOKENS:
            continue
        if not _has_complete_speech_boundaries(candidate, segments, duration_sec):
            continue
        if _silence_ratio(start_sec, end_sec, silence) > 0.45:
            continue

        ranked.append(candidate)

    ranked.sort(
        key=lambda candidate: (
            float(candidate.get("engagementScore", 0)),
            bool(candidate.get("transcriptVerified", True)),
            float(candidate.get("audioEnergy", 0.0)),
            float(candidate.get("visualScore", 0.0)),
            float(candidate.get("durationSec", 0.0)),
        ),
        reverse=True,
    )

    min_gap = 3.0 if duration_sec >= 90.0 else 0.0
    selected: List[Dict[str, Any]] = []

    def can_accept(candidate: Dict[str, Any]) -> bool:
        start_sec = float(candidate["startSec"])
        end_sec = float(candidate["endSec"])
        for existing in selected:
            existing_start = float(existing["startSec"])
            existing_end = float(existing["endSec"])
            if _temporal_overlap_ratio(start_sec, end_sec, existing_start, existing_end) > 0.08:
                return False
            if min_gap > 0 and _temporal_gap_sec(start_sec, end_sec, existing_start, existing_end) < min_gap:
                return False
            if _is_lexical_near_duplicate(
                str(candidate.get("transcript") or ""), str(existing.get("transcript") or "")
            ):
                return False
        return True

    # Long-form videos benefit from timeline coverage, but only candidates that
    # passed the same quality checks above may satisfy a chapter bucket.
    if duration_sec >= 1200.0 and requested >= 2 and ranked:
        top_score = float(ranked[0].get("engagementScore", 0))
        bucket_span = duration_sec / float(requested)
        for bucket_index in range(requested):
            bucket_start = bucket_index * bucket_span
            bucket_end = (bucket_index + 1) * bucket_span
            for candidate in ranked:
                midpoint = 0.5 * (float(candidate["startSec"]) + float(candidate["endSec"]))
                if (
                    bucket_start <= midpoint <= bucket_end
                    and float(candidate.get("engagementScore", 0)) >= top_score - 15.0
                    and can_accept(candidate)
                ):
                    selected.append(candidate)
                    break

    for candidate in ranked:
        if len(selected) >= requested:
            break
        if can_accept(candidate):
            selected.append(candidate)

    return sorted(selected, key=lambda candidate: float(candidate["startSec"]))
