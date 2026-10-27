EXPENSO SERVER - RAILWAY DEPLOYMENT
===================================

Node >= 20 required. Railway's Nixpacks builder detects this project
automatically: it runs `npm ci`, then `npm run build`, then `npm start`.
No Dockerfile needed.


1. CREATE THE SERVICES
----------------------
  - Add this folder as a Railway service (root directory = the folder
    containing package.json).
  - Add the Postgres plugin. It provides DATABASE_URL automatically.


2. ENVIRONMENT VARIABLES
------------------------
Railway -> service -> Variables.

REQUIRED
  NODE_ENV=production
  DATABASE_URL   Reference the Postgres plugin's variable. Prefer the
                 INTERNAL host (*.railway.internal) so traffic stays on the
                 private network. If you use the PUBLIC proxy host instead,
                 append ?sslmode=no-verify - otherwise the connection fails
                 on Railway's self-signed certificate. The pool in
                 src/db/client.ts sets no SSL options of its own.
  JWT_SECRET     Random, 32+ characters. The server REFUSES to start in
                 production with a short or default value.
                 Generate with: openssl rand -base64 48
  WEB_ORIGIN     Comma-separated browser origins allowed to call the API.
                 Used for CORS and Socket.IO.
                 e.g. https://expenso.rhythmrx.ai

DO NOT SET
  PORT           Railway injects it; the server already reads it.
  DEV_ECHO_OTP   Must stay off. It returns sign-in codes in API responses,
                 and the server refuses to boot with it on in production.

FILE STORAGE - IMPORTANT
  Railway containers have an EPHEMERAL filesystem. Anything written to disk
  is LOST on every redeploy and restart. The default STORAGE_DRIVER=local
  will silently lose every receipt, document and export.

  Use S3 or any S3-compatible store:
    STORAGE_DRIVER=s3
    S3_BUCKET=expenso-files
    S3_REGION=ap-south-1
    S3_ENDPOINT=                 (only for MinIO / R2 / Spaces)
    AWS_ACCESS_KEY_ID=...        (read by the AWS SDK)
    AWS_SECRET_ACCESS_KEY=...
  The alternative is a Railway Volume mounted at STORAGE_DIR.

EMAIL (one-time sign-in codes, app links, daily digest)
  Without SMTP_URL these messages are only written to the log, which means
  nobody can sign in by email code. For a real deployment set:
    SMTP_URL=smtps://user:password@smtp.example.com:465
    MAIL_FROM=Expenso <expenso@rhythmrx.ai>
    WEB_URL=https://expenso.rhythmrx.ai
    APP_DOWNLOAD_URL=https://expenso.rhythmrx.ai/app

OPTIONAL
  RUN_JOBS=true          Scheduler + export worker. Keep ON for at least one
                         instance. If you scale beyond 1 replica, turn it
                         OFF on the extras - these jobs are not distributed
                         and would double-run.
  JOB_INTERVAL_SECONDS=30
  MAX_UPLOAD_MB=20
  DIGEST_HOUR_IST=9
  MIGRATE_ON_START=true  See section 3.
  SUPPORT_CONTACT_NAME= / SUPPORT_CONTACT_EMAIL=
  WEB_DIST_DIR=          Serve the built React console from this process.

Every variable is documented with comments in .env.example.


3. DATABASE MIGRATIONS
----------------------
Migrations run automatically at start-up. The SQL files in drizzle/ are
included in this zip and must stay in the deployed files.

To migrate separately, set MIGRATE_ON_START=false and run:
    npm run db:migrate

`npm run db:seed` loads demo data - do NOT run it against production.


4. VERIFY
---------
    curl https://<your-app>.up.railway.app/api/v1/health
Expect: {"ok":true,"time":"...","version":"0.1.0"}

Set Railway's health check path to /api/v1/health


5. POINT THE CLIENTS AT IT
--------------------------
Mobile release build (one line):
    flutter build apk --release --dart-define=API_BASE=https://<your-app>.up.railway.app/api/v1

The web console needs its own API base set at build time, and its origin
must be listed in WEB_ORIGIN or the browser blocks every request.


EXCLUDED FROM THIS ZIP
----------------------
  node_modules/   reinstalled by `npm ci` from package-lock.json
  dist/           produced by `npm run build`
  data/           uploaded receipts/exports from a dev machine
  .env            the dev machine's secrets - use .env.example instead

Nothing else was changed. Verified: `npm run build` completes clean.
