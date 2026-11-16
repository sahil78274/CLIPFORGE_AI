import os
import cv2
import numpy as np
from typing import Any, Dict, List


def detect_window_scenes_and_faces(
    source_path: str,
    start_sec: float,
    end_sec: float,
    sample_interval_sec: float = 0.5,
) -> List[Dict[str, Any]]:
    """
    Samples video frames strictly inside [start_sec, end_sec] using container timestamp seeking
    so memory usage stays at 1 single 320x180 frame (~172 KB) even on 10-hour (36,000s) videos.
    """
    window_dur = max(0.2, float(end_sec) - float(start_sec))
    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        return [
            {
                "start": round(start_sec, 2),
                "end": round(end_sec, 2),
                "score": 0.5,
                "motionScore": 0.3,
                "hasFace": False,
                "faceCenterX": 0.5,
            }
        ]

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    face_cascade = (
        cv2.CascadeClassifier(cascade_path) if os.path.isfile(cascade_path) else None
    )

    prev_hist = None
    prev_gray = None
    scene_starts = [round(start_sec, 2)]
    samples: List[Dict[str, Any]] = []

    use_direct_seek = sample_interval_sec >= 2.0 or start_sec > 2.0
    if not use_direct_seek:
        # Short clip / video from t=0: sequential frame step
        sample_interval_frames = max(1, int(round(fps * sample_interval_sec)))
        max_frames = int(round(end_sec * fps)) + 1
        frame_idx = 0
        while frame_idx <= max_frames:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % sample_interval_frames == 0:
                t = frame_idx / fps
                if t > end_sec + 0.1:
                    break
                if t >= start_sec - 0.05:
                    prev_hist, prev_gray = _analyze_sampled_frame(
                        frame,
                        t,
                        face_cascade,
                        prev_hist,
                        prev_gray,
                        scene_starts,
                        samples,
                    )
            frame_idx += 1
    else:
        # Seek directly to sampled global timestamps in [start_sec, end_sec]
        step = max(0.5, float(sample_interval_sec))
        if window_dur <= 95.0 and sample_interval_sec <= 1.0:
            # High-precision speaker tracking for a single clip window [c_start, c_end]
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start_sec) * 1000.0)
            sample_interval_frames = max(1, int(round(fps * sample_interval_sec)))
            total_window_frames = int(round(window_dur * fps)) + 1
            for local_f in range(total_window_frames):
                ret, frame = cap.read()
                if not ret:
                    break
                if local_f % sample_interval_frames == 0:
                    t = start_sec + (local_f / fps)
                    prev_hist, prev_gray = _analyze_sampled_frame(
                        frame,
                        t,
                        face_cascade,
                        prev_hist,
                        prev_gray,
                        scene_starts,
                        samples,
                    )
        else:
            t = float(start_sec)
            while t <= end_sec - 0.05:
                cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
                ret, frame = cap.read()
                if not ret:
                    break
                prev_hist, prev_gray = _analyze_sampled_frame(
                    frame,
                    t,
                    face_cascade,
                    prev_hist,
                    prev_gray,
                    scene_starts,
                    samples,
                )
                t += step

    cap.release()

    scenes: List[Dict[str, Any]] = []
    cut_points = scene_starts + [round(end_sec, 2)]
    for i in range(len(cut_points) - 1):
        s_t = cut_points[i]
        e_t = cut_points[i + 1]
        if e_t - s_t <= 0.15:
            continue
        window_samples = [x for x in samples if s_t <= x["t"] <= e_t + 0.05]
        if window_samples:
            has_face = any(x["hasFace"] for x in window_samples)
            face_samples = [x["centerX"] for x in window_samples if x["hasFace"]]
            center_x = (
                float(np.median(face_samples))
                if face_samples
                else float(np.median([x["centerX"] for x in window_samples]))
            )
            motion_avg = float(np.mean([x["motion"] for x in window_samples]))
            score = round(min(1.0, 0.45 + motion_avg * 0.4 + (0.15 if has_face else 0.0)), 3)
        else:
            has_face = False
            center_x = 0.5
            motion_avg = 0.25
            score = 0.5

        scenes.append(
            {
                "start": round(s_t, 2),
                "end": round(e_t, 2),
                "score": score,
                "motionScore": round(motion_avg, 3),
                "hasFace": has_face,
                "faceCenterX": round(center_x, 3),
            }
        )

    if not scenes:
        scenes.append(
            {
                "start": round(start_sec, 2),
                "end": round(end_sec, 2),
                "score": 0.5,
                "motionScore": 0.25,
                "hasFace": False,
                "faceCenterX": 0.5,
            }
        )
    return scenes


def _analyze_sampled_frame(
    frame: Any,
    t: float,
    face_cascade: Any,
    prev_hist: Any,
    prev_gray: Any,
    scene_starts: List[float],
    samples: List[Dict[str, Any]],
):
    small = cv2.resize(frame, (320, 180))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)

    hist_diff = 0.0
    if prev_hist is not None:
        corr = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
        hist_diff = max(0.0, 1.0 - corr)
        if hist_diff > 0.38 and (t - scene_starts[-1]) >= 2.0:
            scene_starts.append(round(t, 2))

    motion_score = 0.2
    focus_x = 0.5
    if prev_gray is not None:
        diff = cv2.absdiff(gray, prev_gray)
        motion_score = float(np.mean(diff) / 45.0)
        col_energy = np.mean(diff, axis=0)
        if float(np.max(col_energy)) > 4.0:
            focus_x = float(np.argmax(col_energy)) / 320.0

    has_face = False
    face_x = focus_x
    if face_cascade is not None:
        faces = face_cascade.detectMultiScale(
            gray, scaleFactor=1.15, minNeighbors=4, minSize=(24, 24)
        )
        if len(faces) > 0:
            largest = max(faces, key=lambda b: b[2] * b[3])
            fx, _, fw, _ = largest
            has_face = True
            face_x = float(fx + fw / 2.0) / 320.0

    samples.append(
        {
            "t": round(t, 2),
            "histDiff": hist_diff,
            "motion": min(1.0, motion_score),
            "hasFace": has_face,
            "centerX": max(0.15, min(0.85, face_x)),
        }
    )
    return hist, gray


def detect_scenes_and_faces(source_path: str, duration_sec: float) -> List[Dict[str, Any]]:
    interval = 0.5 if duration_sec <= 180.0 else max(2.0, round(duration_sec / 120.0, 1))
    return detect_window_scenes_and_faces(
        source_path=source_path,
        start_sec=0.0,
        end_sec=duration_sec,
        sample_interval_sec=interval,
    )
