import json
import math
import os
from typing import Any, Dict, List, Optional


MAX_TEN_HOURS_SEC = 36000.0


def build_chunk_plan(
    duration_sec: float,
    chunk_duration_sec: float = 600.0,
    chunk_overlap_sec: float = 5.0,
) -> List[Dict[str, Any]]:
    """
    Divides [0, duration_sec] into bounded chunks with symmetric overlap padding
    [winStart, winEnd] so spoken sentences crossing chunk boundaries stay intact
    while maintaining exact global video timestamps.
    """
    safe_dur = max(1.0, float(duration_sec))
    c_len = max(15.0, float(chunk_duration_sec))
    ov = max(0.0, min(float(chunk_overlap_sec), c_len * 0.25))
    half_ov = round(ov / 2.0, 3)

    if safe_dur <= c_len * 1.15:
        return [
            {
                "index": 0,
                "coreStart": 0.0,
                "coreEnd": round(safe_dur, 3),
                "winStart": 0.0,
                "winEnd": round(safe_dur, 3),
                "isFirst": True,
                "isLast": True,
            }
        ]

    num_chunks = int(math.ceil(safe_dur / c_len))
    chunks: List[Dict[str, Any]] = []
    for idx in range(num_chunks):
        core_start = round(idx * c_len, 3)
        core_end = round(min(safe_dur, (idx + 1) * c_len), 3)
        if core_end - core_start < 0.5:
            break
        is_first = idx == 0
        is_last = (idx == num_chunks - 1) or (core_end >= safe_dur - 0.05)
        win_start = 0.0 if is_first else round(max(0.0, core_start - half_ov), 3)
        win_end = round(safe_dur, 3) if is_last else round(min(safe_dur, core_end + half_ov), 3)
        chunks.append(
            {
                "index": idx,
                "coreStart": core_start,
                "coreEnd": core_end,
                "winStart": win_start,
                "winEnd": win_end,
                "isFirst": is_first,
                "isLast": is_last,
            }
        )
    if chunks:
        chunks[-1]["isLast"] = True
        chunks[-1]["coreEnd"] = round(safe_dur, 3)
        chunks[-1]["winEnd"] = round(safe_dur, 3)
    return chunks


def load_checkpoint(checkpoint_path: str) -> Optional[Dict[str, Any]]:
    if not checkpoint_path or not os.path.isfile(checkpoint_path):
        return None
    try:
        with open(checkpoint_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "completedChunkIndices" in data:
            return data
    except Exception:
        return None
    return None


def save_checkpoint_atomic(checkpoint_path: str, payload: Dict[str, Any]) -> None:
    if not checkpoint_path:
        return
    os.makedirs(os.path.dirname(os.path.abspath(checkpoint_path)), exist_ok=True)
    tmp_path = f"{checkpoint_path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp_path, checkpoint_path)
