import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ITranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface ITranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: ITranscriptWord[];
}

export interface ISceneItem {
  start: number;
  end: number;
  score: number;
  motionScore: number;
  hasFace: boolean;
  faceCenterX: number;
}

export interface IVideo extends Document {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  originalFilename: string;
  storageKey: string;
  storageProvider: 'local' | 's3';
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec?: string;
  hasAudio: boolean;
  thumbnailKey?: string;
  transcriptionEngine?: string;
  detectedLanguage?: string;
  transcript: ITranscriptSegment[];
  scenes: ISceneItem[];
  status: 'uploaded' | 'validated' | 'analyzed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    originalFilename: { type: String, required: true },
    storageKey: { type: String, required: true },
    storageProvider: { type: String, enum: ['local', 's3'], default: 'local' },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    durationSec: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    fps: { type: Number, default: 30 },
    codec: { type: String, default: 'unknown' },
    audioCodec: { type: String },
    hasAudio: { type: Boolean, default: true },
    thumbnailKey: { type: String },
    transcriptionEngine: { type: String },
    detectedLanguage: { type: String, default: 'en' },
    transcript: { type: [Schema.Types.Mixed] as any, default: [] },
    scenes: { type: [Schema.Types.Mixed] as any, default: [] },
    status: {
      type: String,
      enum: ['uploaded', 'validated', 'analyzed', 'failed'],
      default: 'uploaded',
    },
  },
  { timestamps: true }
);

export const Video = mongoose.model<IVideo>('Video', videoSchema);
