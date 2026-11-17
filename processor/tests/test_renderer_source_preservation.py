"""Export regressions: no burned text overlays and source audio remains mapped."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from processor.rendering.renderer import render_single_clip


class SourcePreservingRendererTests(unittest.TestCase):
    def test_render_has_no_subtitle_or_text_filter_and_maps_source_audio(self):
        with tempfile.TemporaryDirectory() as tempdir:
            output_path = os.path.join(tempdir, "clip.mp4")
            thumb_path = os.path.join(tempdir, "clip.jpg")
            successful = SimpleNamespace(returncode=0, stderr="")

            with mock.patch("processor.rendering.renderer.subprocess.run", return_value=successful) as run:
                render_single_clip(
                    ffmpeg_path="ffmpeg",
                    source_path=os.path.join(tempdir, "source.mp4"),
                    clip_work_dir=tempdir,
                    output_mp4_path=output_path,
                    output_thumb_path=thumb_path,
                    start_sec=12.0,
                    duration_sec=20.0,
                    video_filter_base="crop=720:1280:0:0,scale=720:1280",
                    has_source_audio=True,
                )

            self.assertEqual(run.call_count, 2)  # export and thumbnail extraction
            command = run.call_args_list[0].args[0]
            self.assertIn("0:a?", command)
            self.assertIn("0:v:0", command)
            self.assertNotIn("-af", command)
            self.assertNotIn("-filter_complex", command)
            self.assertFalse(any("ass=" in str(arg).lower() for arg in command))
            self.assertFalse(any("drawtext" in str(arg).lower() for arg in command))
            self.assertFalse(any("afade" in str(arg).lower() for arg in command))
            self.assertFalse(any("loudnorm" in str(arg).lower() for arg in command))
            self.assertFalse(any("amix" in str(arg).lower() for arg in command))

    def test_silent_source_gets_only_a_silent_compatibility_track(self):
        with tempfile.TemporaryDirectory() as tempdir:
            successful = SimpleNamespace(returncode=0, stderr="")
            with mock.patch("processor.rendering.renderer.subprocess.run", return_value=successful) as run:
                render_single_clip(
                    ffmpeg_path="ffmpeg",
                    source_path=os.path.join(tempdir, "source.mp4"),
                    clip_work_dir=tempdir,
                    output_mp4_path=os.path.join(tempdir, "clip.mp4"),
                    output_thumb_path=os.path.join(tempdir, "clip.jpg"),
                    start_sec=0.0,
                    duration_sec=12.0,
                    video_filter_base="scale=720:1280",
                    has_source_audio=False,
                )

            command = run.call_args_list[0].args[0]
            self.assertIn("anullsrc=channel_layout=stereo:sample_rate=44100", command)
            self.assertIn("1:a:0", command)
            self.assertNotIn("0:a:0", command)


if __name__ == "__main__":
    unittest.main()
