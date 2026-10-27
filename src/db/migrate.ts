import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db, pool } from './client.js';

export async function runMigrations() {
  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  await migrate(db, { migrationsFolder: folder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations().then(() => { console.log('migrations applied'); return pool.end(); }).catch(e => { console.error(e); process.exit(1); });
}
