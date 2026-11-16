# 12-Stage Video Processing Pipeline

The Python media engine (`processor/main.py`) executes a deterministic 12-stage pipeline over source videos and streams real-time progress events (`CF_EVENT:` / `CF_ERROR:`) to the Node worker.

---

## Stage Breakdown

| # | Stage Slug | Module | Real Media Operations Performed |
| :- | :--- | :--- | :--- |
| 1 | `importing` | `processor/main.py` | Verifies local workspace paths and initializes isolated per-job temp working folders. |
| 2 | `validating` | `ingestion/validator.py` | Runs `ffprobe -show_format -show_streams` to validate video stream presence, dimensions, FPS, codec, audio stream, and duration bounds (`>= 3s`). |
| 3 | `extracting_audio` | `transcription/audio_extractor.py` | Extracts mono 16 kHz PCM WAV (`pcm_s16le`) for ASR/acoustic analysis and probes embedded subtitle streams (`subrip` / `mov_text` / `webvtt`). |
| 4 | `transcribing` | `transcription/transcriber.py` | Runs **Faster-Whisper** (`word_timestamps=True`, Silero VAD) when local/cached CTranslate2 weights are available; falls back seamlessly to embedded subtitle tracks or offline **PocketSphinx** ASR + RMS speech-island detection. |
| 5 | `detecting_scenes` | `analysis/scene_detector.py` | Samples frames with OpenCV (`cv2`), computing HSV histogram correlation cuts, frame-difference motion saliency centroids, and Haar frontal-face speaker X coordinates. |
| 6 | `analyzing_content` | `analysis/content_analyzer.py` | Computes 100ms RMS dBFS energy windows, detects dead-air silence spans, and maps speech rate (WPM), question hooks, and topical transitions across sentences. |
| 7 | `detecting_moments` | `clip_detection/moment_detector.py` | Builds sentence-aligned candidate windows matching the target duration preset (`15-30s`, `30-45s`, `45-60s`, `60-90s`, or `custom`) and scores Hook Strength, Clarity, Emotional Peak, Pacing, and Completeness (`0–100` Editorial Engagement Estimate). |
| 8 | `selecting_clips` | `clip_detection/clip_selector.py` | Selects top `N` non-overlapping candidate clips (`overlap < 20%`), expanding to clean non-overlapping timeline windows when short videos have closely spaced moments, sorted chronologically. |
| 9 | `editing` | `video_editor/{reframer,subtitle_generator,audio_chain}.py` | Computes speaker-tracked crop filters (`9:16` → `720x1280`, `1:1` → `720x720`, `16:9` → `1280x720`) + optional subtle zoom, trims boundary dead-air while keeping subtitle timestamps synchronized, generates multi-layer `captions.ass` (`Caption`, `Watermark`, `Banner`), and prepares the audio filterchain (`highpass` + `afftdn` denoising + EBU R128 `loudnorm` + optional synthesized ambient harmonic pad). |
| 10 | `rendering` | `rendering/renderer.py` | Executes `ffmpeg` (`libx264`, `yuv420p`, `aac 160k`, `ass=captions.ass`, `-movflags +faststart`) in `clip_work_dir` and extracts a `640px` JPEG thumbnail frame. |
| 11 | `validating_output` | `rendering/output_validator.py` | Verifies every rendered MP4 with `ffprobe` (file size, container streams, exact target aspect dimensions, positive duration). |
| 12 | `completed` | `workers/videoWorker.ts` | Uploads MP4s & thumbnails to storage, generates platform metadata, persists `Clip` documents, settles reserved credits, creates user notification, and deletes temp working directory. |

---

## Multi-Layer ASS Subtitle & Overlay Rendering

To avoid cross-platform Windows drive-letter colon (`C:\...`) escaping issues inside FFmpeg filtergraphs:
1. `subtitle_generator.py` writes `captions.ass` directly inside each clip's isolated working directory (`clip_XX/captions.ass`) with three dedicated ASS styles:
   - `Caption`: Word-synced `{\kf}` karaoke, `{\t(\fscx108\fscy108)}` word-pop highlight, `{\fad}` smooth fade, or static clean lines.
   - `Watermark`: Persistent semi-transparent top-right creator handle/brand badge.
   - `Banner`: Timed intro (`0.0s–2.2s`) and outro (`duration-2.2s–duration`) callout cards.
2. `renderer.py` executes `ffmpeg` with `cwd=clip_work_dir` and passes relative `ass=captions.ass`, guaranteeing identical behavior on Windows PowerShell, Linux, and Docker containers.
