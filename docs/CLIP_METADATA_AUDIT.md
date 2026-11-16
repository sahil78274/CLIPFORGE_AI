# AI Clip Metadata — Audit & Integration Fixes

Scope: the 9 automatic clip-metadata features. Existing Gemini integration
(`server/src/services/aiService.ts`) and the existing transcription pipeline
(`processor/transcription/transcriber.py` + `processor/video_editor/subtitle_generator.py`)
were reused — no parallel or mock systems were added. YouTube media acquisition and OAuth
configuration were not touched.

## Verdicts

| # | Feature | Before | After |
|---|---|---|---|
| 1 | Automatic speech transcription | Fully implemented | **Fully implemented** |
| 2 | Word-level animated captions | Partially implemented | **Fully implemented** |
| 3 | Automatic engaging title | Partially implemented | **Fully implemented** |
| 4 | SEO-friendly description | Partially implemented | **Fully implemented** |
| 5 | Relevant hashtags | Partially implemented | **Fully implemented** |
| 6 | Automatic thumbnail | Fully implemented | **Fully implemented** |
| 7 | Metadata saved in MongoDB | Fully implemented | **Fully implemented** |
| 8 | Editable metadata in dashboard | Partially implemented | **Fully implemented** |
| 9 | Metadata on download/export | Not implemented | **Fully implemented** |

### Evidence per feature

1. **Transcription** — `transcribe_chunk_media()` (faster-whisper → embedded SRT →
   PocketSphinx → acoustic VAD) runs per chunk with global timestamps; word timings are
   attached to every segment. Stored in `Video.transcript` and `Clip.transcript`.
2. **Word-level captions** — `generate_ass_subtitles()` writes word-timed ASS with
   `word_pop` / `karaoke` / `fade`; `renderer.py` burns it (`ass=`). Was: timings discarded
   after ASS generation, so captions could not be displayed, edited or exported, and edited
   text was ignored on re-render.
3. **Titles** — the Gemini/deterministic provider returns 3 `titleOptions`; the worker
   promotes `titleOptions[0]` to `Clip.title`. Was: editing `titleOptions[0]` left
   `Clip.title` stale.
4. **Descriptions** — 4 platform variants plus a canonical `seoDescription`.
   Was: no canonical SEO field, and `updateMetadata` shallow-merged so patching one
   platform erased the other three.
5. **Hashtags** — content-derived from the clip transcript, plus `keywords`. Was: raw LLM
   output accepted verbatim (non-strings, missing `#`, `[]` bypassing the fallback).
6. **Thumbnail** — JPEG grabbed at 25 % into the clip, uploaded as `thumbnailKey`, served
   through the signed `/thumbnail` endpoint, shown in the dashboard.
7. **Persistence** — `Clip.metadata` (Mixed, required), `Clip.captions`, `Clip.captionStyle`,
   `Video.transcript`, `Video.scenes`.
8. **Dashboard editing** — `ClipLibraryPage` AI-Copy modal edits title options, opening hook,
   thumbnail text, SEO + 4 platform descriptions, hashtags and keywords; the new caption
   editor edits the word-timed cues; the re-render modal exposes aspect ratio and caption
   style (animation/position/colours/size).
9. **Export** — single-clip `metadata?format=json|txt`, `captions.srt`, `package` ZIP
   (MP4 + TXT + JSON + SRT), and metadata sidecars inside the existing bulk ZIP.

## Changes made

**Processor**
- `video_editor/subtitle_generator.py`: new `extract_clip_caption_cues()` derives
  clip-relative word-timed cues from the **same** segment/word data the ASS generator
  consumes (4-word cue grouping, interpolation when a segment has no word timings).
- `main.py`: every rendered clip now returns `captions` + `captionSource`
  (`word_timestamps` | `segment_interpolated`). A `regenerate_clip` job carrying
  `regenerateSpec.captionCues` re-burns the edited cues through the same
  `generate_ass_subtitles()` call.

**Server**
- `services/aiService.ts`: `sanitizeHashtags` / `sanitizeKeywords` / `sanitizeTitleOptions`
  (unicode-aware, `#`-prefixed, deduped, capped); empty/malformed LLM arrays now fall back
  instead of shipping empty metadata; `seoDescription` added to the deterministic builder,
  Gemini prompt/parser and the OpenAI-compatible provider.
- `models/Clip.ts`: `metadata.seoDescription`, `captions[]`, `captionSource`.
- `workers/videoWorker.ts`: persists `captions`/`captionSource` on create and on
  regenerate; forwards edited cues into `regenerateSpec`.
- `controllers/clipController.ts`: deep merge + validation + title sync in
  `updateMetadata`; new `updateCaptions`, `downloadMetadata`, `downloadCaptions`,
  `downloadPackage`; bulk ZIP now emits `.txt`/`.json`/`.srt` sidecars plus
  `clipforge_manifest.json`.
- `routes/index.ts`: `PATCH /:id/captions`, `GET /:id/metadata`, `GET /:id/captions.srt`,
  `GET /:id/package`.

**Client**
- `types/api.ts`: `CaptionCue`, `ClipMetadata.seoDescription`, `ClipItem.captions`.
- `services/api.ts`: `updateCaptions`, `downloadCaptionsSrt`, `downloadMetadataFile`,
  `downloadPackage`, `saveBlob()` authenticated-download helper.
- `pages/dashboard/ClipLibraryPage.tsx`: SEO description field, keywords field,
  "Copy caption + hashtags", caption cue editor (edit/delete/save, SRT export), per-clip
  "With Metadata" package download, and caption-style controls in the re-render modal.

## Verification

- `npm run typecheck` — shared/server/client pass.
- `npm run build` — pass.
- `npm run test` — 5 files / **39 tests** pass, 2 of them new suites of assertions:
  - `clipMetadata.unit.test.ts` (8 tests): hashtag/keyword/title sanitisation, unicode,
    caps, deterministic fallback always producing hashtags + SEO copy.
  - `e2e.integration.test.ts`: real 12-stage pipeline now also asserts `seoDescription`,
    `#`-prefixed hashtags, persisted word-timed captions with `endSec > startSec`,
    ZIP sidecar/manifest entries, single-clip JSON/TXT/SRT/package exports, deep-merged
    metadata edits with title sync, caption save + SRT round-trip, 400 on invalid cues,
    and 403 for cross-tenant export access.

## Known limitation

Edited caption cues are persisted and placed in exports immediately; they are burned into
the MP4 when the clip is re-rendered (`POST /clips/:id/regenerate`, which passes
`captions` through). The dashboard shows this explicitly ("re-render to burn these in").
