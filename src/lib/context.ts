import { db, type Tx } from '../db/client.js';
import { log } from './logger.js';

export interface Actor {
  id: string | null;          // null = the server itself (scheduler)
  name: string;
  isFinance: boolean;
  isAdmin: boolean;
  departmentId: string | null;
  client: 'mobile' | 'web' | 'system';
}
export const SYSTEM: Actor = { id: null, name: 'Expenso server', isFinance: false, isAdmin: false, departmentId: null, client: 'system' };

/** Everything a service needs: the transaction, who is acting, the clock, and work to run after commit. */
export interface Ctx {
  tx: Tx;
  actor: Actor;
  now: Date;
  after: Array<() => unknown>;
}

/** Run fn in one transaction; side effects (push, websocket) queued in ctx.after run only after commit. */
export async function withTx<T>(actor: Actor, fn: (ctx: Ctx) => Promise<T>, now: Date = new Date()): Promise<T> {
  const after: Ctx['after'] = [];
  const result = await db.transaction(async tx => fn({ tx, actor, now, after }));
  for (const f of after) {
    try { await f(); } catch (e) { log.error({ err: e }, 'after-commit hook failed'); }
  }
  return result;
}
