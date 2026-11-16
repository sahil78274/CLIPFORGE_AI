export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const REDACT_KEYS = /password|secret|token|authorization|cookie|signature|api_key|apikey/i;

function sanitizeMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta.map(sanitizeMeta);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message };
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeMeta(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ? (sanitizeMeta(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') emit('debug', msg, meta);
  },
};
