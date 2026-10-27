/** Shared test helpers: an app instance, sign-in as a demo person, and small request wrappers. */
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DEMO_PASSWORD, emailOf } from '../src/db/seed.js';

export const app = createApp();
export const api = () => request(app);

export interface Session { token: string; refreshToken: string; user: { id: string; name: string } }
const cache = new Map<string, Session>();

export async function login(key: string, client: 'mobile' | 'web' = 'mobile', fresh = false): Promise<Session> {
  const k = `${key}:${client}`;
  if (!fresh && cache.has(k)) return cache.get(k)!;
  const r = await api().post('/api/v1/auth/login').send({ email: emailOf(key), password: DEMO_PASSWORD, client });
  if (r.status !== 200) throw new Error(`login ${key} ${client}: ${r.status} ${JSON.stringify(r.body)}`);
  const s = { token: r.body.accessToken, refreshToken: r.body.refreshToken, user: r.body.user };
  cache.set(k, s);
  return s;
}
export const clearSessions = () => cache.clear();

export function as(s: Session) {
  const h = (req: request.Test) => req.set('Authorization', `Bearer ${s.token}`);
  return {
    get: (u: string) => h(api().get(`/api/v1${u}`)),
    post: (u: string, body?: object) => h(api().post(`/api/v1${u}`)).send(body ?? {}),
    put: (u: string, body?: object) => h(api().put(`/api/v1${u}`)).send(body ?? {}),
    patch: (u: string, body?: object) => h(api().patch(`/api/v1${u}`)).send(body ?? {}),
    del: (u: string, body?: object) => h(api().delete(`/api/v1${u}`)).send(body ?? {}),
    raw: (method: 'put' | 'get', u: string) => h(api()[method](`/api/v1${u}`)),
  };
}
