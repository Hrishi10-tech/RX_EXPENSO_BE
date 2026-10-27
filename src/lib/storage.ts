import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../config.js';

/** Object storage for receipts, finance documents and exports. Local disk in development, S3 in production. */
export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  /** Store a file from disk without loading it into memory (exports have no size cap, FR-EXPT-05). */
  putFile(key: string, file: string, mime: string): Promise<number>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements Storage {
  constructor(private root: string) {}
  private p(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('bad storage key');
    return full;
  }
  async put(key: string, body: Buffer) { const f = this.p(key); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, body); }
  async putFile(key: string, file: string) {
    const f = this.p(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.copyFile(file, f);
    return (await fs.stat(f)).size;
  }
  async get(key: string) { return fs.readFile(this.p(key)); }
  async stream(key: string) { const f = this.p(key); await fs.access(f); return createReadStream(f); }
  async delete(key: string) { await fs.rm(this.p(key), { force: true }); }
}

class S3Storage implements Storage {
  private clientP = import('@aws-sdk/client-s3').then(m => ({ m, c: new m.S3Client({ region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: !!config.S3_ENDPOINT }) }));
  async put(key: string, body: Buffer, mime: string) { const { m, c } = await this.clientP; await c.send(new m.PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: mime })); }
  async putFile(key: string, file: string, mime: string) {
    const { m, c } = await this.clientP;
    const size = (await fs.stat(file)).size;
    await c.send(new m.PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: mime }));
    return size;
  }
  async get(key: string) {
    const { m, c } = await this.clientP;
    const r = await c.send(new m.GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async stream(key: string) {
    const { m, c } = await this.clientP;
    const r = await c.send(new m.GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return r.Body as Readable;
  }
  async delete(key: string) { const { m, c } = await this.clientP; await c.send(new m.DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key })); }
}

export const storage: Storage = config.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(path.resolve(config.STORAGE_DIR));

/** RFC 6266 header so names with spaces, rupee signs or Indian scripts survive the download. */
export function contentDisposition(name: string, inline = false) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
