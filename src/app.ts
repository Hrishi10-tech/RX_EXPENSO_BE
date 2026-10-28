import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/client.js';
import { errorHandler } from './lib/http.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { exportsRouter } from './routes/exports.js';
import { financeRouter } from './routes/finance.js';
import { memberRouter } from './routes/member.js';

/** Raw SQL returns timestamps in PostgreSQL text form; every response carries ISO 8601 UTC instead. */
const PG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;
export function isoReplacer(_key: string, v: unknown) {
  if (typeof v === 'string' && PG_TS.test(v)) {
    const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return v;
}

/** Where the built console lives, and the CSP hashes of its inline scripts (the theme is set before first paint). */
function webBundle() {
  const dir = path.resolve(config.WEB_DIST_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'));
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) return null;
  const html = fs.readFileSync(index, 'utf8');
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return { dir, index, hashes };
}

export function createApp() {
  const app = express();
  const web = webBundle();
  app.set('json replacer', isoReplacer);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // The console shows receipts and PDFs from blob: URLs and talks to the API over WebSocket.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", ...(web?.hashes ?? [])], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'ws:', 'wss:'], frameSrc: ["'self'", 'blob:'], objectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
        upgradeInsecureRequests: null, // internal deployments may run plain HTTP behind a proxy
      },
    },
  }));
  app.use(cors({ origin: config.WEB_ORIGIN.split(',').map(s => s.trim()), credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(compression());
  app.get('/api/v1/health', (_req, res) => { res.json({ ok: true, time: new Date().toISOString(), version: '0.1.0' }); });
  // Confirms PostgreSQL answers too; 503 when it doesn't, so a host's health check can tell the two apart.
  app.get('/api/v1/health/db', async (_req, res) => {
    const started = Date.now();
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, database: 'up', latencyMs: Date.now() - started, time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ ok: false, database: 'down', error: err instanceof Error ? err.message : String(err), time: new Date().toISOString() });
    }
  });
  const api = express.Router();
  api.use((req, res, next) => (req.method === 'PUT' && /\/attachments\/[^/]+\/content$/.test(req.path) ? next() : express.json({ limit: '1mb' })(req, res, next)));
  api.use(authRouter);
  api.use(exportsRouter);
  api.use('/admin', adminRouter);
  api.use('/finance', financeRouter);
  api.use(memberRouter);
  app.use('/api/v1', api);
  app.use('/api', (_req, res) => { res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }); });
  // One process can serve the finance console too: the built React app, with client-side routes falling back to index.html.
  if (web) {
    app.use(express.static(web.dir, { index: false, maxAge: '1h', setHeaders: (res, file) => { if (/\/assets\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(web.index); });
  }
  app.use(errorHandler);
  return app;
}
