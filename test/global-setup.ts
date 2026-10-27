/** Once per run: a clean schema in the test database, migrated to the latest version. */
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://expenso:expenso@localhost:5432/expenso_test';
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle') });
  await pool.end();
}
