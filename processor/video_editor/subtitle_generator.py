from typing import Any, Dict, List


def _hex_to_ass_color(hex_color: str, opacity: float = 1.0) -> str:
    """Convert #RRGGBB + opacity (0..1) into ASS &HAABBGGRR format (AA=00 opaque, FF transparent)."""
    clean = (hex_color or "#FFFFFF").lstrip("#")
    if len(clean) != 6:
        clean = "FFFFFF"
    r = clean[0:2]
    g = clean[2:4]
    b = clean[4:6]
    alpha = max(0, min(255, int(round((1.0 - max(0.0, min(1.0, opacity))) * 255))))
    return f"&H{alpha:02X}{b.upper()}{g.upper()}{r.upper()}"


def _format_ass_time(sec: float) -> str:
    sec = max(0.0, sec)
    hrs = int(sec // 3600)
    mins = int((sec % 3600) // 60)
    secs = sec % 60
    return f"{hrs}:{mins:02d}:{secs:05.2f}"


def _escape_ass_text(txt: str) -> str:
    return (
        (txt or "")
        .replace("\\", "")
        .replace("{", "(")
        .replace("}", ")")
        .replace("\n", " ")
        .strip()
    )


def generate_ass_subtitles(
    ass_path: str,
    play_w: int,
    play_h: int,
    clip_start: float,
    clip_end: float,
    segments: List[Dict[str, Any]],
    caption_style: Dict[str, Any],
    watermark_enabled: bool,
    watermark_text: str,
    intro_text: str,
    outro_text: str,
) -> List[str]:
    applied: List[str] = []
    clip_dur = max(0.5, clip_end - clip_start)

    font_raw = str(caption_style.get("font") or "DejaVu Sans")
    font_name = "DejaVu Sans"
    bold_flag = -1 if "bold" in font_raw.lower() else 0
    if "mono" in font_raw.lower():
        font_name = "DejaVu Sans Mono"

    font_size = max(22, min(72, int(caption_style.get("fontSize") or 40)))
    primary_ass = _hex_to_ass_color(str(caption_style.get("textColor") or "#FFFFFF"), 1.0)
    highlight_ass = _hex_to_ass_color(str(caption_style.get("highlightColor") or "#38BDF8"), 1.0)
    bg_opacity = float(caption_style.get("backgroundOpacity", 0.65))
    back_ass = _hex_to_ass_color(str(caption_style.get("backgroundColor") or "#09090B"), bg_opacity)
    outline_ass = "&H20000000"

    pos = str(caption_style.get("position") or "bottom")
    if pos == "top":
        alignment = 8
        margin_v = int(play_h * 0.10)
    elif pos == "middle":
        alignment = 5
        margin_v = 20
    else:
        alignment = 2
        margin_v = int(play_h * 0.11)

    animation = str(caption_style.get("animation") or "word_pop")
    border_style = 3 if bg_opacity >= 0.25 else 1

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {play_w}
PlayResY: {play_h}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font_name},{font_size},{primary_ass},{highlight_ass},{outline_ass},{back_ass},{bold_flag},0,0,0,100,100,0,0,{border_style},3,1,{alignment},42,42,{margin_v},1
Style: Watermark,DejaVu Sans,24,&H55FFFFFF,&H55FFFFFF,&H90000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,9,28,28,28,1
Style: Banner,DejaVu Sans,30,&H00FFFFFF,&H00FFFFFF,&H20000000,&H5012121A,-1,0,0,0,100,100,0,0,3,6,0,8,40,40,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events: List[str] = []

    # Watermark overlay
    if watermark_enabled and watermark_text.strip():
        wm = _escape_ass_text(watermark_text.strip())
        events.append(
            f"Dialogue: 2,{_format_ass_time(0.0)},{_format_ass_time(clip_dur)},Watermark,,0,0,0,,{wm}"
        )
        applied.append("Brand watermark overlay")

    # Intro banner (first 2.2s)
    if intro_text and intro_text.strip():
        ib = _escape_ass_text(intro_text.strip())
        end_ib = min(clip_dur, 2.2)
        events.append(
            f"Dialogue: 3,{_format_ass_time(0.0)},{_format_ass_time(end_ib)},Banner,,0,0,0,,{{\\fad(200,250)}}{ib}"
        )
        applied.append("Intro callout banner")

    # Outro banner (final 2.2s)
    if outro_text and outro_text.strip() and clip_dur > 3.0:
        ob = _escape_ass_text(outro_text.strip())
        start_ob = max(0.0, clip_dur - 2.2)
        events.append(
            f"Dialogue: 3,{_format_ass_time(start_ob)},{_format_ass_time(clip_dur)},Banner,,0,0,0,,{{\\fad(250,200)}}{ob}"
        )
        applied.append("Outro callout banner")

    # Animated speech captions
    if caption_style.get("enabled", True):
        # Gather words inside [clip_start, clip_end]
        clip_words: List[Dict[str, Any]] = []
        for seg in segments:
            if seg["end"] <= clip_start or seg["start"] >= clip_end:
                continue
            words = seg.get("words") or []
            if words:
                for w in words:
                    if w["end"] > clip_start and w["start"] < clip_end:
                        clip_words.append(
                            {
                                "word": _escape_ass_text(w["word"]),
                                "start": max(0.0, float(w["start"]) - clip_start),
                                "end": min(clip_dur, float(w["end"]) - clip_start),
                            }
                        )
            else:
                tokens = [_escape_ass_text(t) for t in seg["text"].split() if t.strip()]
                if tokens:
                    s_rel = max(0.0, float(seg["start"]) - clip_start)
                    e_rel = min(clip_dur, float(seg["end"]) - clip_start)
                    step = max(0.15, (e_rel - s_rel) / len(tokens))
                    for k, tok in enumerate(tokens):
                        clip_words.append(
                            {
                                "word": tok,
                                "start": s_rel + k * step,
                                "end": min(clip_dur, s_rel + (k + 1) * step),
                            }
                        )

        chunk_size = 4
        for idx in range(0, len(clip_words), chunk_size):
            group = [w for w in clip_words[idx : idx + chunk_size] if w["word"]]
            if not group:
                continue

            if animation == "word_pop":
                # Emit one timed event per word in the group with active highlight color!
                for active_i, active_w in enumerate(group):
                    w_s = active_w["start"]
                    w_e = (
                        group[active_i + 1]["start"]
                        if active_i + 1 < len(group)
                        else active_w["end"]
                    )
                    if w_e - w_s < 0.08:
                        w_e = min(clip_dur, w_s + 0.12)
                    parts = []
                    for j, gw in enumerate(group):
                        if j == active_i:
                            parts.append(f"{{\\c{highlight_ass}}}{gw['word']}{{\\c{primary_ass}}}")
                        else:
                            parts.append(gw["word"])
                    line_txt = " ".join(parts)
                    events.append(
                        f"Dialogue: 1,{_format_ass_time(w_s)},{_format_ass_time(w_e)},Caption,,0,0,0,,{line_txt}"
                    )
            elif animation == "karaoke":
                g_s = group[0]["start"]
                g_e = max(g_s + 0.25, group[-1]["end"])
                k_parts = []
                for gw in group:
                    centisec = max(8, int(round((gw["end"] - gw["start"]) * 100)))
                    k_parts.append(f"{{\\kf{centisec}}}{gw['word']}")
                events.append(
                    f"Dialogue: 1,{_format_ass_time(g_s)},{_format_ass_time(g_e)},Caption,,0,0,0,,{' '.join(k_parts)}"
                )
            elif animation == "fade":
                g_s = group[0]["start"]
                g_e = max(g_s + 0.25, group[-1]["end"])
                txt = " ".join(gw["word"] for gw in group)
                events.append(
                    f"Dialogue: 1,{_format_ass_time(g_s)},{_format_ass_time(g_e)},Caption,,0,0,0,,{{\\fad(120,120)}}{txt}"
                )
            else:
                g_s = group[0]["start"]
                g_e = max(g_s + 0.25, group[-1]["end"])
                txt = " ".join(gw["word"] for gw in group)
                events.append(
                    f"Dialogue: 1,{_format_ass_time(g_s)},{_format_ass_time(g_e)},Caption,,0,0,0,,{txt}"
                )

        if clip_words:
            applied.append(f"Animated ASS subtitles ({animation})")

    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(events) + "\n")

    return applied
