from typing import Any, Dict, List


def _temporal_overlap_ratio(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    if inter <= 0.0:
        return 0.0
    shortest = max(0.1, min(a_end - a_start, b_end - b_start))
    return inter / shortest


def select_unique_clips(
    candidates: List[Dict[str, Any]],
    desired_count: int,
    duration_sec: float,
) -> List[Dict[str, Any]]:
    ranked = sorted(
        candidates,
        key=lambda c: (c.get("engagementScore", 0), c.get("durationSec", 0)),
        reverse=True,
    )

    selected: List[Dict[str, Any]] = []
    for cand in ranked:
        if len(selected) >= desired_count:
            break
        overlaps = any(
            _temporal_overlap_ratio(
                cand["startSec"], cand["endSec"], ex["startSec"], ex["endSec"]
            )
            > 0.15
            for ex in selected
        )
        if not overlaps and cand["endSec"] - cand["startSec"] >= 1.5:
            selected.append(cand)

    # If user requested multiple clips on a compact video and segments were tightly grouped,
    # partition remaining non-overlapping windows cleanly without duplicating moments.
    if len(selected) < desired_count and duration_sec >= desired_count * 4.0:
        slice_len = round(duration_sec / desired_count, 2)
        for idx in range(desired_count):
            if len(selected) >= desired_count:
                break
            s_t = round(idx * slice_len, 2)
            e_t = round(min(duration_sec, (idx + 1) * slice_len), 2)
            overlaps = any(
                _temporal_overlap_ratio(s_t, e_t, ex["startSec"], ex["endSec"]) > 0.2
                for ex in selected
            )
            if not overlaps and (e_t - s_t) >= 2.0:
                selected.append(
                    {
                        "startSec": s_t,
                        "endSec": e_t,
                        "durationSec": round(e_t - s_t, 2),
                        "transcript": f"Segment {idx + 1} highlight.",
                        "title": f"Part {idx + 1} Highlight",
                        "category": "insight",
                        "reason": "Distinct non-overlapping chapter window.",
                        "engagementScore": 68,
                    }
                )

    return sorted(selected, key=lambda x: x["startSec"])
