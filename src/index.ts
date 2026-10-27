/** Expenso API server: HTTP + Socket.IO, the scheduler (NFR-14) and the export worker (FR-EXPT-05). */
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { config } from './config.js';
import { db, pool, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { log } from './lib/logger.js';
import { setIo } from './lib/realtime.js';
import { getMember, isAccepted } from './modules/domain.js';
import { startExportWorker, stopExportWorker } from './modules/exports/service.js';

export function attachRealtime(server: http.Server) {
  const io = new Server(server, {
    path: '/api/v1/socket.io',
    cors: { origin: config.WEB_ORIGIN.split(',').map(s => s.trim()), credentials: true },
  });
  // The access token authenticates the socket; the user is loaded fresh so a deactivated account cannot connect.
  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const p = jwt.verify(token, config.JWT_SECRET, { issuer: 'expenso' }) as { sub: string; cl: 'mobile' | 'web' };
      const u = (await db.select().from(schema.users).where(eq(schema.users.id, p.sub)))[0];
      if (!u?.active) return next(new Error('deactivated'));
      socket.data.user = { id: u.id, isFinance: u.isFinance, client: p.cl };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', socket => {
    const u = socket.data.user as { id: string; isFinance: boolean; client: string };
    void socket.join(`user:${u.id}`);
    void socket.join(`user:${u.id}:${u.client === 'web' ? 'web' : 'mobile'}`);
    if (u.isFinance && u.client === 'web') void socket.join('finance');
    // Members follow the trips they have open; finance may follow any trip.
    socket.on('trip:watch', async (tripId: unknown, ack?: (ok: boolean) => void) => {
      const id = String(tripId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return ack?.(false);
      const ok = u.isFinance || isAccepted(await getMember(db, id, u.id).catch(() => undefined));
      if (ok) void socket.join(`trip:${id}`);
      ack?.(ok);
    });
    socket.on('trip:unwatch', (tripId: unknown) => { void socket.leave(`trip:${String(tripId ?? '')}`); });
  });
  setIo(io);
  return io;
}

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await runMigrations();
  const app = createApp();
  const server = http.createServer(app);
  const io = attachRealtime(server);
  server.listen(config.PORT, () => log.info({ port: config.PORT }, 'Expenso API listening'));
  if (config.RUN_JOBS) {
    startScheduler(config.JOB_INTERVAL_SECONDS);
    await startExportWorker();
  }
  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    stopScheduler();
    stopExportWorker();
    io.close();
    server.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(e => { log.fatal({ err: e }, 'failed to start'); process.exit(1); });
