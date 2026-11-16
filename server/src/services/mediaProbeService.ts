import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { env } from '../config/env';
import { BadRequestError } from '../utils/errors';

const execFileAsync = promisify(execFile);

export interface MediaProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec?: string;
  hasAudio: boolean;
  sizeBytes: number;
}

export async function checkMediaBinaries(): Promise<{
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
}> {
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;

  try {
    await execFileAsync(env.FFMPEG_PATH, ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  try {
    await execFileAsync(env.FFPROBE_PATH, ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }

  return { ffmpegAvailable, ffprobeAvailable };
}

function parseFrameRate(rateStr?: string): number {
  if (!rateStr) return 30;
  const parts = rateStr.split('/').map(Number);
  if (parts.length === 2 && parts[1] > 0) {
    const val = parts[0] / parts[1];
    return Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : 30;
  }
  const direct = Number(rateStr);
  return Number.isFinite(direct) && direct > 0 ? direct : 30;
}

export async function probeMediaFile(filePath: string): Promise<MediaProbeInfo> {
  if (!fs.existsSync(filePath)) {
    throw new BadRequestError('Uploaded video file could not be read', 'FILE_MISSING');
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    throw new BadRequestError('Uploaded video file is empty', 'EMPTY_VIDEO_FILE');
  }

  let stdout: string;
  try {
    const res = await execFileAsync(
      env.FFPROBE_PATH,
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 20000 }
    );
    stdout = res.stdout;
  } catch {
    throw new BadRequestError(
      'File failed FFprobe media validation. Ensure the file is a valid uncorrupted MP4, MOV, WebM, or MKV video.',
      'INVALID_MEDIA_CONTAINER'
    );
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new BadRequestError('Unable to parse media container metadata', 'INVALID_MEDIA_METADATA');
  }

  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new BadRequestError(
      'Uploaded file does not contain a valid video stream.',
      'NO_VIDEO_STREAM'
    );
  }

  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);
  const durationSec = Number(
    data?.format?.duration || videoStream.duration || 0
  );

  if (width <= 0 || height <= 0 || !Number.isFinite(durationSec) || durationSec <= 0.5) {
    throw new BadRequestError(
      'Video must have valid dimensions and a duration of at least 1 second.',
      'INVALID_VIDEO_DIMENSIONS_OR_DURATION'
    );
  }

  return {
    durationSec: Math.round(durationSec * 100) / 100,
    width,
    height,
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    codec: String(videoStream.codec_name || 'h264'),
    audioCodec: audioStream ? String(audioStream.codec_name) : undefined,
    hasAudio: Boolean(audioStream),
    sizeBytes: stat.size,
  };
}
