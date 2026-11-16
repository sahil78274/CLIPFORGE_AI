import re
from typing import Any, Dict, List, Set


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
    tokens = re.findall(r"[a-z0-9]{3,}", (text or "").lower())
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


def select_unique_clips(
    candidates: List[Dict[str, Any]],
    desired_count: int,
    duration_sec: float,
    min_dur: float = 15.0,
    max_dur: float = 30.0,
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

    # Partition clean bounded windows if compact video had fewer distinct candidates than requested
    if len(selected) < desired_count and duration_sec >= desired_count * 4.0:
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
                        "transcript": f"Chapter {idx + 1} highlight.",
                        "title": f"Part {idx + 1} Highlight",
                        "category": "insight",
                        "reason": "Distinct non-overlapping timeline window.",
                        "engagementScore": 68,
                    }
                )

    return sorted(selected, key=lambda x: x["startSec"])
