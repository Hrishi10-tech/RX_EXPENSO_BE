/** ZIP packaging (SRS §8.3). Entries are streamed one at a time, so the package has no size cap (FR-EXPT-05). */
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';

export interface ZipItem {
  path: string;
  /** A file on local disk (statements built for this export). */
  file?: string;
  /** Opens the stored attachment; called only when the entry is written. */
  open?: () => Promise<Readable>;
  /** Shown in the error when the source can't be read. */
  label?: string;
}

const STORED = /\.(jpe?g|png|webp|heic|pdf|xlsx|docx|zip|gz)$/i;

export class ZipSourceError extends Error {
  constructor(public label: string, cause: unknown) { super(`Couldn’t read ${label} from storage.`, { cause }); }
}

export async function writeZip(target: string, items: ZipItem[], onEntry?: (done: number, total: number) => void): Promise<number> {
  const out = createWriteStream(target);
  const zip = new ZipArchive({ zlib: { level: 6 }, forceLocalTime: true });
  zip.pipe(out);
  let done = 0;
  try {
    for (const it of items) {
      let src: Readable;
      try { src = it.file ? createReadStream(it.file) : await it.open!(); } catch (e) { throw new ZipSourceError(it.label ?? it.path, e); }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { zip.off('entry', ok); zip.off('error', bad); src.off('error', badSrc); };
        const ok = () => { cleanup(); resolve(); };
        const bad = (e: Error) => { cleanup(); reject(e); };
        const badSrc = (e: Error) => { cleanup(); reject(new ZipSourceError(it.label ?? it.path, e)); };
        zip.once('entry', ok);
        zip.once('error', bad);
        src.once('error', badSrc);
        zip.append(src, { name: it.path, store: STORED.test(it.path) });
      });
      onEntry?.(++done, items.length);
    }
    const closed = once(out, 'close');
    await zip.finalize();
    await closed;
    return zip.pointer();
  } catch (e) {
    zip.abort();
    out.destroy();
    throw e;
  }
}
