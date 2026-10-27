import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError, badRequest } from './errors.js';
import { log } from './logger.js';

/** Validate input with zod; every problem is returned at once so forms can show all errors (M03·b, M09·c). */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('validation', 'Some fields need attention.', r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  const e = err as { code?: string; type?: string; message?: string; status?: number };
  if (e?.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: { code: 'file_too_large', message: 'The file is larger than the limit.' } }); return; }
  if (e?.type === 'entity.too.large') { res.status(413).json({ error: { code: 'too_large', message: 'Request too large.' } }); return; }
  if (e?.type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON.' } }); return; }
  log.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
}

export const zId = z.uuid();
export const zDateTime = z.iso.datetime({ offset: true }).transform(s => new Date(s));
export const zDate = z.iso.date();
export const zPaise = z.number().int().positive().max(100_000_000_00);
