import json
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
        "Preserve the exact global startSec and endSec values from the provided segments and never cut mid-sentence. "
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
        f"{gemini_model}:generateContent?key={gemini_api_key}"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
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

    if ai_provider == "openai_compatible" and openai_api_key:
        ai_candidates = _try_openai_moment_scoring(
            segments, openai_api_key, openai_base_url, openai_model, effective_min, effective_max, clip_count
        )
    else:
        ai_candidates = _try_gemini_moment_scoring(
            segments, gemini_api_key, gemini_model, effective_min, effective_max, clip_count
        )

    used_ai = len(ai_candidates) > 0
    candidates: List[Dict[str, Any]] = []

    if used_ai:
        for item in ai_candidates:
            s_t = max(0.0, float(item.get("startSec", window_start_sec)))
            e_t = min(duration_sec, float(item.get("endSec", 0.0)))
            if e_t - s_t < 2.5 or e_t - s_t > effective_max * 1.35:
                continue
            seg_texts = [
                seg["text"]
                for seg in segments
                if seg["end"] > s_t + 0.1 and seg["start"] < e_t - 0.1
            ]
            candidates.append(
                {
                    "startSec": round(s_t, 2),
                    "endSec": round(e_t, 2),
                    "durationSec": round(e_t - s_t, 2),
                    "transcript": " ".join(seg_texts).strip() or str(item.get("title") or ""),
                    "title": str(item.get("title") or "AI Selected Highlight"),
                    "category": str(item.get("category") or "insight"),
                    "reason": str(item.get("reason") or "AI-selected complete engaging moment."),
                    "engagementScore": max(45, min(96, int(item.get("engagementScore", 82)))),
                }
            )

    # Deterministic sentence-boundary + acoustic + visual moment scoring
    n_segs = len(segments)
    for i in range(n_segs):
        start_t = float(segments[i]["start"])
        gathered_texts: List[str] = []

        for j in range(i, n_segs):
            end_t = float(segments[j]["end"])
            gathered_texts.append(segments[j]["text"])
            span = end_t - start_t

            if span < effective_min and j < n_segs - 1:
                continue
            if span > effective_max and len(gathered_texts) > 1:
                break

            full_text = " ".join(gathered_texts).strip()
            ends_cleanly = full_text.endswith((".", "!", "?")) or j == n_segs - 1

            e_vals = [x["rms"] for x in energy_timeline if start_t <= x["t"] <= end_t]
            mean_rms = sum(e_vals) / len(e_vals) if e_vals else 0.03
            energy_bonus = min(15.0, mean_rms * 180.0)

            ov_scenes = [sc for sc in scenes if sc["end"] > start_t and sc["start"] < end_t]
            has_face = any(sc.get("hasFace") for sc in ov_scenes)
            motion_bonus = (
                sum(sc.get("motionScore", 0.2) for sc in ov_scenes) / len(ov_scenes) * 10.0
                if ov_scenes
                else 3.0
            )

            category = _classify_text(full_text)
            sentence_bonus = 8.0 if ends_cleanly else 0.0
            hook_bonus = 7.0 if ("?" in full_text[:80] or category in ("hook", "surprising")) else 3.0
            face_bonus = 6.0 if has_face else 0.0

            raw_score = int(
                round(54.0 + energy_bonus + motion_bonus + sentence_bonus + hook_bonus + face_bonus)
            )
            score = max(50, min(95, raw_score))

            words_preview = [w for w in full_text.replace(".", "").split() if len(w) > 2][:6]
            suggested_title = (
                " ".join(words_preview).title() if words_preview else f"Highlight ({start_t:.0f}s)"
            )

            reason_parts = [f"Complete {category} segment"]
            if has_face:
                reason_parts.append("active speaker face tracked")
            if energy_bonus > 6:
                reason_parts.append("strong vocal energy peak")

            candidates.append(
                {
                    "startSec": round(start_t, 2),
                    "endSec": round(end_t, 2),
                    "durationSec": round(span, 2),
                    "transcript": full_text,
                    "title": suggested_title[:90],
                    "category": category,
                    "reason": ", ".join(reason_parts).capitalize() + ".",
                    "engagementScore": score,
                }
            )
            if span >= effective_min:
                break

    if not candidates and window_span >= 1.5:
        fb_start = round(float(segments[0]["start"]) if segments else window_start_sec, 2)
        fb_end = round(min(duration_sec, fb_start + min(effective_max, window_span)), 2)
        if fb_end - fb_start >= 1.5:
            full_txt = " ".join(s["text"] for s in segments).strip() or "Chapter highlight."
            candidates.append(
                {
                    "startSec": fb_start,
                    "endSec": fb_end,
                    "durationSec": round(fb_end - fb_start, 2),
                    "transcript": full_txt,
                    "title": f"Highlight ({int(fb_start // 60)}m)",
                    "category": "hook",
                    "reason": "Complete chapter highlight window.",
                    "engagementScore": 70,
                }
            )

    # Keep top candidates per chunk so checkpoint files remain compact even across 60+ chunks
    candidates.sort(key=lambda c: (c.get("engagementScore", 0), c.get("durationSec", 0)), reverse=True)
    return {"candidates": candidates[: max(12, clip_count * 4)], "usedAi": used_ai}
