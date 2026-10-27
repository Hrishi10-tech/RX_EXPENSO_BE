/**
 * Outgoing email: one-time sign-in codes (M01·a, W01), the app link (W10) and the finance daily digest (FR-NOT-05).
 * Configure SMTP_URL (for example smtps://user:pass@smtp.example.com:465). Without it, messages go to the server log,
 * which is what development and tests want.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { log } from './logger.js';

let transport: Transporter | null | undefined;
function getTransport() {
  if (transport === undefined) transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;
  return transport;
}

export interface Mail { to: string; subject: string; text: string; html?: string }
export const outbox: Mail[] = []; // the last messages, for tests and the dev log

export async function sendMail(m: Mail): Promise<{ delivered: boolean }> {
  outbox.push(m);
  if (outbox.length > 50) outbox.shift();
  const t = getTransport();
  if (!t) {
    log.info({ to: m.to, subject: m.subject }, 'email (SMTP not configured; logged only)');
    return { delivered: false };
  }
  try {
    await t.sendMail({ from: config.MAIL_FROM, ...m });
    return { delivered: true };
  } catch (e) {
    log.error({ err: e, to: m.to, subject: m.subject }, 'email failed');
    return { delivered: false };
  }
}

export const webUrl = () => (config.WEB_URL ?? config.WEB_ORIGIN.split(',')[0].trim()).replace(/\/$/, '');
