import net from 'net';
import path from 'path';
import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';
import { EmbeddedMongoWireServer } from '../utils/embeddedMongoServer';

let embeddedInstance: EmbeddedMongoWireServer | null = null;
let connectedMode: 'external_mongodb' | 'embedded_wire_fallback' | 'disconnected' = 'disconnected';

function checkTcpPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export async function connectDatabase(customUri?: string): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  let uri = customUri || env.MONGODB_URI;
  const isLocalUri =
    uri.startsWith('mongodb://127.0.0.1') || uri.startsWith('mongodb://localhost');

  if (isLocalUri && env.ENABLE_EMBEDDED_MONGO_FALLBACK) {
    const parsedUrl = new URL(uri.replace('mongodb://', 'http://'));
    const host = parsedUrl.hostname || '127.0.0.1';
    const port = Number(parsedUrl.port || 27017);
    const hasExternalMongod = await checkTcpPortOpen(host, port);

    if (!hasExternalMongod && !embeddedInstance) {
      const dataDir = path.resolve(__dirname, '../../.data/embedded-mongo');
      embeddedInstance = new EmbeddedMongoWireServer(dataDir);
      const boundPort = await embeddedInstance.start(port, '127.0.0.1');
      connectedMode = 'embedded_wire_fallback';
      logger.info('Started embedded MongoDB wire-protocol development server', {
        host: '127.0.0.1',
        port: boundPort,
        dataDir,
      });
      if (boundPort !== port) {
        uri = `mongodb://127.0.0.1:${boundPort}/clipforge_ai?directConnection=true`;
      }
    } else {
      connectedMode = 'external_mongodb';
    }
  } else {
    connectedMode = 'external_mongodb';
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 6000,
  });

  logger.info('Connected to MongoDB via Mongoose', {
    mode: connectedMode,
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (embeddedInstance) {
    await embeddedInstance.stop();
    embeddedInstance = null;
  }
  connectedMode = 'disconnected';
}

export function getDatabaseHealth(): { status: string; mode: string } {
  return {
    status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    mode: connectedMode,
  };
}
