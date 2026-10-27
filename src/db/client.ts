import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

// Return bigint/numeric aggregates as JS numbers: all our money fits comfortably in 2^53 paise.
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => Number(v));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export const db = drizzle(pool, { schema });
export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type Q = DB | Tx;
export { schema };
