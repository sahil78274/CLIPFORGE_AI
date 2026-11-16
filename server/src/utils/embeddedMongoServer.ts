import net from 'net';
import fs from 'fs';
import path from 'path';
import { BSON, EJSON, Long, ObjectId } from 'bson';
import 'mingo/init/system';
import mingo from 'mingo';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { updateObject } = require('mingo/updater') as {
  updateObject: (obj: Record<string, any>, expr: Record<string, any>) => string[];
};

interface IndexDef {
  name: string;
  key: Record<string, number | string>;
  unique?: boolean;
  sparse?: boolean;
}

interface CollectionStore {
  docs: Record<string, any>[];
  indexes: IndexDef[];
}

function getNestedValue(obj: any, dotPath: string): any {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function normalizeComparable(val: any): string {
  if (val === undefined) return '__UNDEFINED__';
  if (val === null) return '__NULL__';
  if (val instanceof ObjectId || val?._bsontype === 'ObjectId') {
    return `oid:${val.toHexString()}`;
  }
  if (val instanceof Date) return `date:${val.getTime()}`;
  if (typeof val === 'object') return EJSON.stringify(val);
  return `${typeof val}:${String(val)}`;
}

function cloneBsonDoc<T>(doc: T): T {
  return BSON.deserialize(BSON.serialize(doc as any)) as T;
}

function extractEqualityFieldsFromFilter(filter: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (k.startsWith('$')) continue;
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ('$eq' in v) out[k] = v.$eq;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class EmbeddedMongoWireServer {
  private server: net.Server | null = null;
  private dbs = new Map<string, Map<string, CollectionStore>>();
  private persistDir: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private connSeq = 1;

  constructor(persistDir: string) {
    this.persistDir = persistDir;
    fs.mkdirSync(this.persistDir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const files = fs.readdirSync(this.persistDir).filter((f) => f.endsWith('.ejson'));
      for (const file of files) {
        const dbName = file.replace(/\.ejson$/, '');
        const raw = fs.readFileSync(path.join(this.persistDir, file), 'utf8');
        const parsed = EJSON.parse(raw) as Record<string, CollectionStore>;
        const colMap = new Map<string, CollectionStore>();
        for (const [colName, colData] of Object.entries(parsed)) {
          colMap.set(colName, {
            docs: Array.isArray(colData.docs) ? colData.docs : [],
            indexes: Array.isArray(colData.indexes)
              ? colData.indexes
              : [{ name: '_id_', key: { _id: 1 }, unique: true }],
          });
        }
        this.dbs.set(dbName, colMap);
      }
    } catch (err) {
      logger.warn('Could not load embedded mongo snapshot; starting clean', { err });
    }
  }

  private scheduleFlush(dbName: string): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushNow(dbName);
    }, 80);
  }

  public flushNow(dbName?: string): void {
    try {
      const targets = dbName ? [dbName] : Array.from(this.dbs.keys());
      for (const db of targets) {
        const colMap = this.dbs.get(db);
        if (!colMap) continue;
        const serializable: Record<string, CollectionStore> = {};
        for (const [name, store] of colMap.entries()) {
          serializable[name] = store;
        }
        const tmpFile = path.join(this.persistDir, `${db}.ejson.tmp`);
        const finalFile = path.join(this.persistDir, `${db}.ejson`);
        fs.writeFileSync(tmpFile, EJSON.stringify(serializable), 'utf8');
        fs.renameSync(tmpFile, finalFile);
      }
    } catch (err) {
      logger.warn('Embedded mongo snapshot flush warning', { err });
    }
  }

  private getCollection(dbName: string, colName: string): CollectionStore {
    let db = this.dbs.get(dbName);
    if (!db) {
      db = new Map();
      this.dbs.set(dbName, db);
    }
    let col = db.get(colName);
    if (!col) {
      col = {
        docs: [],
        indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }],
      };
      db.set(colName, col);
    }
    return col;
  }

  private checkUniqueConstraints(
    dbName: string,
    colName: string,
    store: CollectionStore,
    candidate: Record<string, any>,
    ignoreDocRef?: Record<string, any>
  ): { code: number; errmsg: string; keyPattern: any; keyValue: any } | null {
    for (const idx of store.indexes) {
      if (!idx.unique) continue;
      const keys = Object.keys(idx.key);
      const candValues = keys.map((k) => getNestedValue(candidate, k));

      if (
        idx.sparse &&
        candValues.some((v) => v === undefined || v === null)
      ) {
        continue;
      }

      for (const existing of store.docs) {
        if (ignoreDocRef && existing === ignoreDocRef) continue;
        const matchAll = keys.every(
          (k, i) => normalizeComparable(getNestedValue(existing, k)) === normalizeComparable(candValues[i])
        );
        if (matchAll) {
          const keyValue: Record<string, any> = {};
          keys.forEach((k, i) => {
            keyValue[k] = candValues[i];
          });
          return {
            code: 11000,
            errmsg: `E11000 duplicate key error collection: ${dbName}.${colName} index: ${idx.name} dup key: ${JSON.stringify(keyValue)}`,
            keyPattern: idx.key,
            keyValue,
          };
        }
      }
    }
    return null;
  }

  private applyMongoUpdate(
    targetDoc: Record<string, any>,
    updateSpec: Record<string, any>,
    isInsert: boolean
  ): boolean {
    const keys = Object.keys(updateSpec);
    const hasOperators = keys.some((k) => k.startsWith('$'));

    if (!hasOperators) {
      const keepId = targetDoc._id;
      for (const k of Object.keys(targetDoc)) {
        if (k !== '_id') delete targetDoc[k];
      }
      Object.assign(targetDoc, cloneBsonDoc(updateSpec));
      if (keepId !== undefined) targetDoc._id = keepId;
      return true;
    }

    let modified = false;
    for (const [op, payload] of Object.entries(updateSpec)) {
      if (op === '$setOnInsert') {
        if (isInsert && payload && typeof payload === 'object') {
          updateObject(targetDoc, { $set: cloneBsonDoc(payload) });
          modified = true;
        }
        continue;
      }
      const changed = updateObject(targetDoc, { [op]: cloneBsonDoc(payload) } as any);
      if (changed.length > 0 || isInsert) modified = true;
    }
    return modified;
  }

  private buildHelloResponse(connId: number) {
    return {
      ismaster: true,
      isWritablePrimary: true,
      helloOk: true,
      maxBsonObjectSize: 16777216,
      maxMessageSizeBytes: 48000000,
      maxWriteBatchSize: 100000,
      localTime: new Date(),
      logicalSessionTimeoutMinutes: 30,
      connectionId: connId,
      minWireVersion: 0,
      maxWireVersion: 17,
      readOnly: false,
      ok: 1,
    };
  }

  private handleCommand(cmd: Record<string, any>, connId: number): Record<string, any> {
    const dbName: string = cmd.$db || 'clipforge_ai';

    if (cmd.hello || cmd.ismaster || cmd.isMaster) {
      return this.buildHelloResponse(connId);
    }
    if (cmd.ping) return { ok: 1 };
    if (cmd.buildInfo || cmd.buildinfo) {
      return { version: '6.0.0-embedded', versionArray: [6, 0, 0, 0], bits: 64, ok: 1 };
    }
    if (cmd.whatsmyuri) return { you: '127.0.0.1:0', ok: 1 };
    if (cmd.endSessions || cmd.startSession || cmd.commitTransaction || cmd.abortTransaction) {
      return { ok: 1 };
    }
    if (cmd.getFreeMonitoringStatus) return { state: 'disabled', ok: 1 };

    // listCollections
    if (cmd.listCollections) {
      const colMap = this.dbs.get(dbName);
      const batch = colMap
        ? Array.from(colMap.keys()).map((name) => ({ name, type: 'collection', options: {} }))
        : [];
      return {
        cursor: { id: Long.ZERO, ns: `${dbName}.$cmd.listCollections`, firstBatch: batch },
        ok: 1,
      };
    }

    // createIndexes
    if (typeof cmd.createIndexes === 'string') {
      const colName = cmd.createIndexes;
      const store = this.getCollection(dbName, colName);
      const numBefore = store.indexes.length;
      const specs: IndexDef[] = cmd.indexes || [];
      for (const s of specs) {
        if (!store.indexes.some((x) => x.name === s.name)) {
          store.indexes.push({
            name: s.name || Object.keys(s.key || {}).join('_'),
            key: s.key || {},
            unique: Boolean(s.unique),
            sparse: Boolean(s.sparse),
          });
        }
      }
      this.scheduleFlush(dbName);
      return {
        createdCollectionAutomatically: false,
        numIndexesBefore: numBefore,
        numIndexesAfter: store.indexes.length,
        ok: 1,
      };
    }

    // listIndexes
    if (typeof cmd.listIndexes === 'string') {
      const colName = cmd.listIndexes;
      const store = this.getCollection(dbName, colName);
      return {
        cursor: {
          id: Long.ZERO,
          ns: `${dbName}.${colName}`,
          firstBatch: store.indexes,
        },
        ok: 1,
      };
    }

    // drop / dropDatabase
    if (typeof cmd.drop === 'string') {
      this.dbs.get(dbName)?.delete(cmd.drop);
      this.scheduleFlush(dbName);
      return { nIndexesWas: 1, ns: `${dbName}.${cmd.drop}`, ok: 1 };
    }
    if (cmd.dropDatabase) {
      this.dbs.delete(dbName);
      const file = path.join(this.persistDir, `${dbName}.ejson`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { dropped: dbName, ok: 1 };
    }

    // insert
    if (typeof cmd.insert === 'string') {
      const colName = cmd.insert;
      const store = this.getCollection(dbName, colName);
      const docs: Record<string, any>[] = cmd.documents || [];
      const writeErrors: any[] = [];
      let inserted = 0;

      docs.forEach((rawDoc, index) => {
        const doc = cloneBsonDoc(rawDoc);
        if (doc._id === undefined) doc._id = new ObjectId();
        const dup = this.checkUniqueConstraints(dbName, colName, store, doc);
        if (dup) {
          writeErrors.push({ index, ...dup });
          return;
        }
        store.docs.push(doc);
        inserted += 1;
      });

      if (inserted > 0) this.scheduleFlush(dbName);
      const res: Record<string, any> = { n: inserted, ok: 1 };
      if (writeErrors.length > 0) res.writeErrors = writeErrors;
      return res;
    }

    // find
    if (typeof cmd.find === 'string') {
      const colName = cmd.find;
      const store = this.getCollection(dbName, colName);
      const filter = cmd.filter || {};
      const projection = cmd.projection;
      let cursor = mingo.find(store.docs, filter, projection);
      if (cmd.sort && Object.keys(cmd.sort).length > 0) {
        cursor = cursor.sort(cmd.sort);
      }
      if (typeof cmd.skip === 'number' && cmd.skip > 0) {
        cursor = cursor.skip(cmd.skip);
      }
      if (typeof cmd.limit === 'number' && cmd.limit > 0) {
        cursor = cursor.limit(cmd.limit);
      }
      const results = cursor.all().map((d: any) => cloneBsonDoc(d));
      return {
        cursor: {
          firstBatch: results,
          id: Long.ZERO,
          ns: `${dbName}.${colName}`,
        },
        ok: 1,
      };
    }

    // count
    if (typeof cmd.count === 'string') {
      const colName = cmd.count;
      const store = this.getCollection(dbName, colName);
      const filter = cmd.query || {};
      let matches = mingo.find(store.docs, filter).all();
      if (typeof cmd.skip === 'number' && cmd.skip > 0) matches = matches.slice(cmd.skip);
      if (typeof cmd.limit === 'number' && cmd.limit > 0) matches = matches.slice(0, cmd.limit);
      return { n: matches.length, ok: 1 };
    }

    // distinct
    if (typeof cmd.distinct === 'string') {
      const colName = cmd.distinct;
      const store = this.getCollection(dbName, colName);
      const key: string = cmd.key;
      const filter = cmd.query || {};
      const docs = mingo.find(store.docs, filter).all();
      const seen = new Map<string, any>();
      for (const doc of docs) {
        const val = getNestedValue(doc, key);
        if (Array.isArray(val)) {
          val.forEach((item) => seen.set(normalizeComparable(item), item));
        } else if (val !== undefined) {
          seen.set(normalizeComparable(val), val);
        }
      }
      return { values: Array.from(seen.values()), ok: 1 };
    }

    // aggregate
    if (typeof cmd.aggregate === 'string') {
      const colName = cmd.aggregate;
      const store = this.getCollection(dbName, colName);
      const pipeline: any[] = cmd.pipeline || [];
      const results = mingo.aggregate(store.docs, pipeline).map((d: any) => cloneBsonDoc(d));
      return {
        cursor: {
          firstBatch: results,
          id: Long.ZERO,
          ns: `${dbName}.${colName}`,
        },
        ok: 1,
      };
    }

    // update
    if (typeof cmd.update === 'string') {
      const colName = cmd.update;
      const store = this.getCollection(dbName, colName);
      const updates: any[] = cmd.updates || [];
      let matched = 0;
      let modified = 0;
      const upserted: any[] = [];
      const writeErrors: any[] = [];

      updates.forEach((uItem, index) => {
        const q = uItem.q || {};
        const u = uItem.u || {};
        const multi = Boolean(uItem.multi);
        const upsert = Boolean(uItem.upsert);

        const found = mingo.find(store.docs, q).all() as Record<string, any>[];
        const targets = multi ? found : found.slice(0, 1);

        if (targets.length === 0 && upsert) {
          const newDoc: Record<string, any> = {
            _id: new ObjectId(),
            ...extractEqualityFieldsFromFilter(q),
          };
          this.applyMongoUpdate(newDoc, u, true);
          const dup = this.checkUniqueConstraints(dbName, colName, store, newDoc);
          if (dup) {
            writeErrors.push({ index, ...dup });
            return;
          }
          store.docs.push(newDoc);
          upserted.push({ index, _id: newDoc._id });
        } else {
          for (const target of targets) {
            matched += 1;
            const snapshot = cloneBsonDoc(target);
            const changed = this.applyMongoUpdate(snapshot, u, false);
            const dup = this.checkUniqueConstraints(dbName, colName, store, snapshot, target);
            if (dup) {
              writeErrors.push({ index, ...dup });
              continue;
            }
            for (const k of Object.keys(target)) delete target[k];
            Object.assign(target, snapshot);
            if (changed) modified += 1;
          }
        }
      });

      if (modified > 0 || upserted.length > 0) this.scheduleFlush(dbName);
      const res: Record<string, any> = { n: matched + upserted.length, nModified: modified, ok: 1 };
      if (upserted.length > 0) res.upserted = upserted;
      if (writeErrors.length > 0) res.writeErrors = writeErrors;
      return res;
    }

    // findAndModify
    if (typeof cmd.findAndModify === 'string') {
      const colName = cmd.findAndModify;
      const store = this.getCollection(dbName, colName);
      const query = cmd.query || {};
      let cursor = mingo.find(store.docs, query);
      if (cmd.sort && Object.keys(cmd.sort).length > 0) {
        cursor = cursor.sort(cmd.sort);
      }
      const existing = (cursor.all()[0] as Record<string, any> | undefined) || null;

      if (cmd.remove) {
        if (!existing) {
          return { lastErrorObject: { n: 0 }, value: null, ok: 1 };
        }
        const idx = store.docs.indexOf(existing);
        if (idx >= 0) store.docs.splice(idx, 1);
        this.scheduleFlush(dbName);
        return { lastErrorObject: { n: 1 }, value: cloneBsonDoc(existing), ok: 1 };
      }

      if (!existing) {
        if (!cmd.upsert) {
          return { lastErrorObject: { n: 0, updatedExisting: false }, value: null, ok: 1 };
        }
        const created: Record<string, any> = {
          _id: new ObjectId(),
          ...extractEqualityFieldsFromFilter(query),
        };
        this.applyMongoUpdate(created, cmd.update || {}, true);
        const dup = this.checkUniqueConstraints(dbName, colName, store, created);
        if (dup) {
          return { ok: 0, code: 11000, codeName: 'DuplicateKey', errmsg: dup.errmsg };
        }
        store.docs.push(created);
        this.scheduleFlush(dbName);
        return {
          lastErrorObject: { n: 1, updatedExisting: false, upserted: created._id },
          value: cmd.new ? cloneBsonDoc(created) : null,
          ok: 1,
        };
      }

      const beforeDoc = cloneBsonDoc(existing);
      const candidate = cloneBsonDoc(existing);
      this.applyMongoUpdate(candidate, cmd.update || {}, false);
      const dup = this.checkUniqueConstraints(dbName, colName, store, candidate, existing);
      if (dup) {
        return { ok: 0, code: 11000, codeName: 'DuplicateKey', errmsg: dup.errmsg };
      }
      for (const k of Object.keys(existing)) delete existing[k];
      Object.assign(existing, candidate);
      this.scheduleFlush(dbName);

      return {
        lastErrorObject: { n: 1, updatedExisting: true },
        value: cmd.new ? cloneBsonDoc(existing) : beforeDoc,
        ok: 1,
      };
    }

    // delete
    if (typeof cmd.delete === 'string') {
      const colName = cmd.delete;
      const store = this.getCollection(dbName, colName);
      const deletes: any[] = cmd.deletes || [];
      let removed = 0;

      for (const del of deletes) {
        const q = del.q || {};
        const limit = del.limit === 1 ? 1 : 0;
        const matches = mingo.find(store.docs, q).all() as Record<string, any>[];
        const toRemove = limit === 1 ? matches.slice(0, 1) : matches;
        for (const doc of toRemove) {
          const idx = store.docs.indexOf(doc);
          if (idx >= 0) {
            store.docs.splice(idx, 1);
            removed += 1;
          }
        }
      }

      if (removed > 0) this.scheduleFlush(dbName);
      return { n: removed, ok: 1 };
    }

    return { ok: 1 };
  }

  private parseOpMsg(frame: Buffer): Record<string, any> {
    const msgLen = frame.readInt32LE(0);
    const flagBits = frame.readUInt32LE(16);
    const hasChecksum = (flagBits & 1) === 1;
    const endOffset = hasChecksum ? msgLen - 4 : msgLen;

    let offset = 20;
    let body: Record<string, any> = {};

    while (offset < endOffset) {
      const kind = frame.readUInt8(offset);
      offset += 1;

      if (kind === 0) {
        const docSize = frame.readInt32LE(offset);
        body = BSON.deserialize(frame.subarray(offset, offset + docSize));
        offset += docSize;
      } else if (kind === 1) {
        const seqSize = frame.readInt32LE(offset);
        const seqEnd = offset + seqSize;
        offset += 4;
        const nulIdx = frame.indexOf(0, offset);
        const seqName = frame.subarray(offset, nulIdx).toString('utf8');
        offset = nulIdx + 1;
        const items: any[] = [];
        while (offset < seqEnd) {
          const dSize = frame.readInt32LE(offset);
          items.push(BSON.deserialize(frame.subarray(offset, offset + dSize)));
          offset += dSize;
        }
        body[seqName] = (body[seqName] || []).concat(items);
      } else {
        break;
      }
    }
    return body;
  }

  private encodeOpMsgResponse(responseTo: number, doc: Record<string, any>): Buffer {
    const payload = Buffer.from(BSON.serialize(doc));
    const totalLen = 16 + 4 + 1 + payload.length;
    const out = Buffer.allocUnsafe(totalLen);
    out.writeInt32LE(totalLen, 0);
    out.writeInt32LE(Math.floor(Math.random() * 0x7fffffff), 4);
    out.writeInt32LE(responseTo, 8);
    out.writeInt32LE(2013, 12); // OP_MSG
    out.writeUInt32LE(0, 16); // flagBits = 0
    out.writeUInt8(0, 20); // section kind 0
    payload.copy(out, 21);
    return out;
  }

  private encodeOpReplyResponse(responseTo: number, doc: Record<string, any>): Buffer {
    const payload = Buffer.from(BSON.serialize(doc));
    const totalLen = 16 + 20 + payload.length;
    const out = Buffer.allocUnsafe(totalLen);
    out.writeInt32LE(totalLen, 0);
    out.writeInt32LE(Math.floor(Math.random() * 0x7fffffff), 4);
    out.writeInt32LE(responseTo, 8);
    out.writeInt32LE(1, 12); // OP_REPLY
    out.writeInt32LE(0, 16); // responseFlags
    out.writeBigInt64LE(0n, 20); // cursorID
    out.writeInt32LE(0, 28); // startingFrom
    out.writeInt32LE(1, 32); // numberReturned
    payload.copy(out, 36);
    return out;
  }

  public async start(port = 27017, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const connId = this.connSeq++;
        let buf = Buffer.alloc(0);

        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const msgLen = buf.readInt32LE(0);
            if (buf.length < msgLen) break;
            const frame = buf.subarray(0, msgLen);
            buf = buf.subarray(msgLen);

            const requestId = frame.readInt32LE(4);
            const opCode = frame.readInt32LE(12);

            try {
              if (opCode === 2004) {
                // Legacy OP_QUERY handshake
                const nulIdx = frame.indexOf(0, 20);
                const queryOffset = nulIdx + 1 + 8;
                const docSize = frame.readInt32LE(queryOffset);
                const queryDoc = BSON.deserialize(
                  frame.subarray(queryOffset, queryOffset + docSize)
                );
                const replyDoc = this.handleCommand(queryDoc, connId);
                socket.write(this.encodeOpReplyResponse(requestId, replyDoc));
              } else if (opCode === 2013) {
                const cmd = this.parseOpMsg(frame);
                const replyDoc = this.handleCommand(cmd, connId);
                socket.write(this.encodeOpMsgResponse(requestId, replyDoc));
              }
            } catch (err: any) {
              socket.write(
                this.encodeOpMsgResponse(requestId, {
                  ok: 0,
                  code: 1,
                  errmsg: err?.message || 'Internal wire error',
                })
              );
            }
          }
        });

        socket.on('error', () => {
          // ignore client disconnect
        });
      });

      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const addr = this.server?.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve(boundPort);
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushNow();
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
      this.server = null;
    });
  }
}
