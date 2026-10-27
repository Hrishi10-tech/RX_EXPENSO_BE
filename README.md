# Expenso API

One API for the Flutter member app and the React finance console: Node.js 22, Express 5, TypeScript, PostgreSQL 16
with Drizzle ORM, Socket.IO for live updates, S3-compatible storage for files. The contract is
[../docs/api.md](../docs/api.md); the design is [../docs/architecture.md](../docs/architecture.md).

## Requirements

- Node.js 20 or later (built and tested on 22)
- PostgreSQL 14 or later (built and tested on 16)
- For production: an S3 bucket (or MinIO), an SMTP account, and optionally a Firebase service account for push

## Set up

```bash
createuser -P expenso                      # password: expenso (development)
createdb -O expenso expenso
cp .env.example .env                       # adjust DATABASE_URL, JWT_SECRET, WEB_ORIGIN
npm ci
npm run db:migrate                         # also runs automatically at start-up
npm run db:seed                            # optional: the demo story, relative to today
npm run dev                                # http://localhost:4000/api/v1/health
```

The seed wipes the database first and refuses to run with `NODE_ENV=production`. Demo people sign in with the
password `Expenso@2026` (list in [../docs/api.md](../docs/api.md#demo-accounts)).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with reload (tsx watch) |
| `npm run build` then `npm start` | compile to `dist/` and run it (production) |
| `npm run typecheck` | TypeScript, no output |
| `npm test` | 66 integration tests against the database `expenso_test` (created and migrated for each run) |
| `npm run db:generate` | new SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` / `db:seed` | apply migrations / load the demo |
| `npx tsx scripts/export-once.ts <scope> <trip ref> [member]` | build one export of a seeded trip, for checking layouts |
| `scripts/instance.sh <name> <port> [seed]` | an extra instance on its own database `expenso_<name>` and storage |

Tests need a database `expenso_test` owned by `expenso` (`createdb -O expenso expenso_test`), or set
`TEST_DATABASE_URL`.

## Serving the console

Build the console (`cd ../web && npm ci && npm run build`) and the API serves it from `../web/dist` at `/`, with
client routes falling back to `index.html` and a strict Content Security Policy. `WEB_DIST_DIR` points elsewhere.
One process then serves the console, the API and the live channel.

## Production notes

- Set `NODE_ENV=production`, a random `JWT_SECRET` (32+ characters), `DEV_ECHO_OTP=false`, `STORAGE_DRIVER=s3`
  with the bucket settings, `SMTP_URL`, and `WEB_ORIGIN`/`WEB_URL` for the console address. The server refuses to
  start with a weak secret or with one-time codes echoed.
- Put it behind HTTPS (a reverse proxy or load balancer). `trust proxy` is on for one hop.
- Back up PostgreSQL daily and version the bucket (NFR-12). Nothing is deleted: deactivation and removals are soft.
- Push: `npm i firebase-admin` and set `FCM_SERVICE_ACCOUNT`; without it, notifications still reach every app's
  notification list and live channel.
- Several instances: see the end of [../docs/architecture.md](../docs/architecture.md).

## Layout

```
src/
  index.ts            HTTP server, Socket.IO, scheduler and export worker start-up
  app.ts              Express app: security headers, CORS, JSON, routers, console hosting
  config.ts           environment (zod), with production guards
  db/                 schema, client, migrate, seed, demo receipts
  lib/                auth, context and transactions, audit, notify, push, mailer, storage, realtime, time, money
  modules/            domain rules; trips, locations, expenses, finance, exports, admin, auth
  jobs/scheduler.ts   automatic starts, Extended, reminders, invite reminders, daily digest
  routes/             auth, member, finance, admin, exports, audit
drizzle/              SQL migrations
assets/               fonts (Manrope, JetBrains Mono) and the Xelements mark for PDFs
test/                 integration tests (Vitest + Supertest)
```
