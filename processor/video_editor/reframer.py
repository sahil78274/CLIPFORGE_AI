from typing import Any, Dict, List, Tuple


def compute_reframe_filter(
    src_w: int,
    src_h: int,
    aspect_ratio: str,
    scenes: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    zoom_effects: bool,
    editing_intensity: str,
) -> Tuple[str, int, int, List[str]]:
    applied: List[str] = []

    if aspect_ratio == "9:16":
        target_w, target_h = 720, 1280
        target_aspect = 9.0 / 16.0
    elif aspect_ratio == "1:1":
        target_w, target_h = 720, 720
        target_aspect = 1.0
    else:
        target_w, target_h = 1280, 720
        target_aspect = 16.0 / 9.0

    # Determine tracked horizontal speaker/face center across scenes in clip
    overlapping = [
        sc for sc in scenes if sc["end"] > clip_start and sc["start"] < clip_end
    ]
    if overlapping:
        face_scenes = [sc for sc in overlapping if sc.get("hasFace")]
        if face_scenes:
            focus_x = sum(sc["faceCenterX"] for sc in face_scenes) / len(face_scenes)
            applied.append("OpenCV speaker face reframing")
        else:
            focus_x = sum(sc.get("faceCenterX", 0.5) for sc in overlapping) / len(overlapping)
            applied.append(f"Smart {aspect_ratio} motion-guided reframing")
    else:
        focus_x = 0.5
        applied.append(f"Smart {aspect_ratio} center reframing")

    src_aspect = float(src_w) / float(max(1, src_h))

    if src_aspect > target_aspect + 0.01:
        # Source is wider than target (e.g. 16:9 -> 9:16): crop width around tracked speaker X
        crop_h = src_h
        crop_w = max(2, int(round(crop_h * target_aspect)) // 2 * 2)
        ideal_center_px = focus_x * src_w
        crop_x = int(round(ideal_center_px - crop_w / 2.0))
        crop_x = max(0, min(src_w - crop_w, crop_x))
        crop_y = 0
    elif src_aspect < target_aspect - 0.01:
        # Source is taller than target: crop height
        crop_w = src_w
        crop_h = max(2, int(round(crop_w / target_aspect)) // 2 * 2)
        crop_x = 0
        crop_y = max(0, (src_h - crop_h) // 2)
    else:
        crop_w = (src_w // 2) * 2
        crop_h = (src_h // 2) * 2
        crop_x = 0
        crop_y = 0

    filters = [f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}"]

    # Subtle emphasis punch-in crop/scale when zoomEffects is enabled
    if zoom_effects:
        zoom_factor = (
            1.06
            if editing_intensity == "dynamic"
            else 1.035
            if editing_intensity == "balanced"
            else 1.02
        )
        up_w = int(round(target_w * zoom_factor) // 2 * 2)
        up_h = int(round(target_h * zoom_factor) // 2 * 2)
        filters.append(f"scale={up_w}:{up_h}:flags=lanczos")
        # Gentle dynamic center focus crop back to target resolution
        dx = max(0, (up_w - target_w) // 2)
        dy = max(0, (up_h - target_h) // 2)
        filters.append(f"crop={target_w}:{target_h}:{dx}:{dy}")
        applied.append("Subtle hook emphasis zoom")
    else:
        filters.append(f"scale={target_w}:{target_h}:flags=lanczos")

    filters.append("setsar=1")
    return ",".join(filters), target_w, target_h, applied
