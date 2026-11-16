import os
import cv2
import numpy as np
from typing import Any, Dict, List


def detect_scenes_and_faces(source_path: str, duration_sec: float) -> List[Dict[str, Any]]:
    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        return [
            {
                "start": 0.0,
                "end": round(duration_sec, 2),
                "score": 0.5,
                "motionScore": 0.3,
                "hasFace": False,
                "faceCenterX": 0.5,
            }
        ]

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    sample_interval_frames = max(1, int(round(fps * 0.5)))  # Sample 2 frames per second

    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    face_cascade = (
        cv2.CascadeClassifier(cascade_path) if os.path.isfile(cascade_path) else None
    )

    prev_hist = None
    prev_gray = None
    frame_idx = 0

    scene_starts = [0.0]
    samples: List[Dict[str, Any]] = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval_frames == 0:
            t = frame_idx / fps
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
            prev_hist = hist

            motion_score = 0.2
            focus_x = 0.5
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                motion_score = float(np.mean(diff) / 45.0)
                col_energy = np.mean(diff, axis=0)
                if float(np.max(col_energy)) > 4.0:
                    focus_x = float(np.argmax(col_energy)) / 320.0
            prev_gray = gray

            has_face = False
            face_x = focus_x
            if face_cascade is not None:
                faces = face_cascade.detectMultiScale(
                    gray, scaleFactor=1.15, minNeighbors=4, minSize=(24, 24)
                )
                if len(faces) > 0:
                    # Pick largest detected face (active foreground speaker)
                    largest = max(faces, key=lambda b: b[2] * b[3])
                    fx, _, fw, _ = largest
                    has_face = True
                    face_x = float(fx + fw / 2.0) / 320.0

            samples.append(
                {
                    "t": t,
                    "histDiff": hist_diff,
                    "motion": min(1.0, motion_score),
                    "hasFace": has_face,
                    "centerX": max(0.15, min(0.85, face_x)),
                }
            )

        frame_idx += 1

    cap.release()

    scenes: List[Dict[str, Any]] = []
    cut_points = scene_starts + [round(duration_sec, 2)]
    for i in range(len(cut_points) - 1):
        s_t = cut_points[i]
        e_t = cut_points[i + 1]
        if e_t - s_t <= 0.2:
            continue
        window_samples = [x for x in samples if s_t <= x["t"] <= e_t]
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

    return scenes or [
        {
            "start": 0.0,
            "end": round(duration_sec, 2),
            "score": 0.5,
            "motionScore": 0.25,
            "hasFace": False,
            "faceCenterX": 0.5,
        }
    ]
