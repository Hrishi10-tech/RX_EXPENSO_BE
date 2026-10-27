/** Runs before each test file, before any app module reads its configuration. */
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://expenso:expenso@localhost:5432/expenso_test';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_DIR = path.join(os.tmpdir(), 'expenso-test-storage');
process.env.DEV_ECHO_OTP = 'true';
process.env.RUN_JOBS = 'false';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
