import 'dotenv/config';
import { z } from 'zod';

const bool = (d: boolean) => z.string().optional().transform(v => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://expenso:expenso@localhost:5432/expenso'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-in-production'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  DEV_ECHO_OTP: bool(false),
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  RUN_JOBS: bool(true),
  JOB_INTERVAL_SECONDS: z.coerce.number().int().default(30),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  /** Outgoing mail (one-time codes, app links, the daily digest). Unset: messages are written to the log instead. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Expenso <no-reply@expenso.local>'),
  /** Where people get the mobile app, for "Send app link" (W10). */
  APP_DOWNLOAD_URL: z.string().default('https://expenso.example/app'),
  /** Public address of the finance console, for links in emails. Defaults to the first WEB_ORIGIN. */
  WEB_URL: z.string().optional(),
  /** Who a deactivated person should contact (M01·d). Defaults to the first active administrator. */
  SUPPORT_CONTACT_NAME: z.string().optional(),
  SUPPORT_CONTACT_EMAIL: z.string().optional(),
  /** Built finance console to serve from the API (defaults to ../web/dist when it exists). */
  WEB_DIST_DIR: z.string().optional(),
  /** IST hour at which the daily digest goes to finance users who opted in (FR-NOT-05). */
  DIGEST_HOUR_IST: z.coerce.number().int().min(0).max(23).default(9),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.issues);
  process.exit(1);
}
export const config = parsed.data;
if (config.NODE_ENV === 'production') {
  // Refuse unsafe production settings rather than run with them.
  if (config.JWT_SECRET.startsWith('dev-only') || config.JWT_SECRET.startsWith('change-me') || config.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET must be a random string of at least 32 characters in production');
    process.exit(1);
  }
  if (config.DEV_ECHO_OTP) {
    console.error('DEV_ECHO_OTP must be off in production: it returns sign-in codes in API responses');
    process.exit(1);
  }
}
export const isTest = config.NODE_ENV === 'test';
