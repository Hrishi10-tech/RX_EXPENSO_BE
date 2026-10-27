import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../src/db/seed.js';
import { runScheduledWork } from '../src/jobs/scheduler.js';
import { as, login } from './helpers.js';

let S: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { S = await seed({ exports: false, quiet: true, tinyReceipts: true }); });
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe('home and trip views (FR-TRIP-05/06, FR-ROLE-01..04)', () => {
  it('groups my trips: running, scheduled and closed', async () => {
    const r = await as(await login('arjun')).get('/trips/mine');
    expect(r.status).toBe(200);
    const active = r.body.active.map((t: { name: string }) => t.name);
    expect(active).toContain('MedTech Expo · Bengaluru & Mysuru');
    expect(r.body.scheduled.map((t: { name: string }) => t.name)).toContain('KOL visit · Pune');
    expect(r.body.closed.length).toBeGreaterThanOrEqual(2);
    const mt = r.body.active.find((t: { name: string }) => t.name.startsWith('MedTech'));
    expect(mt.me.running).toBe(true);
    expect(mt.pool.allocatedPaise).toBe(50000_00);
    expect(mt.openQueries).toBe(1);
  });

  it('shows an invitee only the invitation (FR-ROLE-01)', async () => {
    const karthik = as(await login('karthik'));
    const home = await karthik.get('/trips/mine');
    const inv = home.body.invitations.find((t: { name: string }) => t.name.startsWith('Dealer onboarding'));
    expect(inv).toBeTruthy();
    const snap = await karthik.get(`/trips/${inv.id}`);
    expect(snap.body.kind).toBe('invitation');
    expect(snap.body.expenses).toBeUndefined();
    expect(snap.body.overlaps.map((o: { name: string }) => o.name)).toContain('MedTech Expo · Bengaluru & Mysuru');
  });

  it('keeps an individual budget and its expenses private to the member and finance (FR-ROLE-03)', async () => {
    const tripId = S.T.mt;
    const divya = await as(await login('divya')).get(`/trips/${tripId}`);
    expect(divya.body.budgets.individual.allocatedPaise).toBe(15000_00);
    expect(divya.body.expenses.some((e: { description: string }) => e.description === 'Flight to Bengaluru')).toBe(true);

    const karthik = as(await login('karthik'));
    const k = await karthik.get(`/trips/${tripId}`);
    expect(k.body.budgets.individual).toBeNull();
    expect(k.body.expenses.some((e: { description: string }) => e.description === 'Flight to Bengaluru')).toBe(false);
    expect(k.body.totals.visibleSpendPaise).toBeLessThan(divya.body.totals.visibleSpendPaise + 1);
    const flight = await karthik.get(`/expenses/${S.E.d3}`);
    expect(flight.status).toBe(403);
    // Others' pool expenses are visible without remarks, flags or threads.
    const dinner = k.body.expenses.find((e: { description: string }) => e.description === 'Client dinner');
    expect(dinner.remarks).toBeNull();
    expect(dinner.flags).toEqual([]);

    const meera = as(await login('meera', 'web'));
    const f = await meera.get(`/finance/trips/${tripId}`);
    expect(f.body.expenses.some((e: { description: string }) => e.description === 'Flight to Bengaluru')).toBe(true);
    expect(f.body.budgets.individuals[0].memberName).toBe('Divya Raman');
  });

  it('refuses the trip to people who are not on it', async () => {
    const r = await as(await login('joseph')).get(`/trips/${S.T.mt}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_member');
  });
});

describe('lifecycle (SRS §4)', () => {
  let tripId = '';
  it('creates a trip with an owner, a primary location and invitations', async () => {
    const rohan = as(await login('rohan'));
    const r = await rohan.post('/trips', {
      name: 'Hospital visit · Vellore', type: 'multi_day', purpose: 'client_meeting', clientEvent: 'CMC Vellore',
      scheduledStart: hoursFromNow(4), tentativeEnd: hoursFromNow(30), primaryCity: 'Vellore', inviteeIds: [S.U.sneha.id],
    });
    expect(r.status).toBe(201);
    tripId = r.body.trip.id;
    expect(r.body.trip.ref).toMatch(/^EXP-\d{4}-\d{5}$/);
    expect(r.body.locations).toHaveLength(1);
    expect(r.body.members.map((m: { name: string; joinStatus: string }) => `${m.name}:${m.joinStatus}`)).toEqual(['Rohan Das:accepted', 'Sneha Pillai:invited']);
  });

  it('only invites active colleagues from the department who have signed in (FR-MEM-01)', async () => {
    const rohan = as(await login('rohan'));
    const r = await rohan.post(`/trips/${tripId}/invites`, { userIds: [S.U.aditi.id] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('not_invitable');
    const other = await rohan.post(`/trips/${tripId}/invites`, { userIds: [S.U.suresh.id] });
    expect(other.status).toBe(422);
  });

  it('warns about overlapping locations and accepts a confirmed overlap (FR-LOC-07)', async () => {
    const rohan = as(await login('rohan'));
    const snap = await rohan.get(`/trips/${tripId}`);
    const day = snap.body.locations[0].arrivalDate;
    const clash = await rohan.post(`/trips/${tripId}/locations`, { city: 'Katpadi', arrivalDate: day, departureDate: snap.body.locations[0].departureDate });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('location_overlap');
    expect(clash.body.error.details.suggestion.city).toBe('Vellore');
    const ok = await rohan.post(`/trips/${tripId}/locations`, { city: 'Katpadi', arrivalDate: day, departureDate: snap.body.locations[0].departureDate, confirmOverlap: true });
    expect(ok.status).toBe(201);
  });

  it('starts early, tells the others, ends, and closes when the last member ends (FR-START, FR-END)', async () => {
    const rohan = as(await login('rohan'));
    const sneha = as(await login('sneha'));
    expect((await sneha.post(`/trips/${tripId}/respond`, { accept: true })).status).toBe(200);
    const st = await rohan.post(`/trips/${tripId}/start`);
    expect(st.status).toBe(200);
    expect(st.body.earlyMinutes).toBeGreaterThan(200);
    const notes = await sneha.get('/notifications');
    expect(notes.body.items.some((n: { type: string; tripId: string }) => n.type === 'member.started_early' && n.tripId === tripId)).toBe(true);
    // Sneha is started automatically at the scheduled start by the server clock.
    await runScheduledWork(new Date(Date.now() + 5 * 3600_000));
    const after = await sneha.get(`/trips/${tripId}`);
    expect(after.body.me.startMethod).toBe('automatic');
    const e1 = await rohan.post(`/trips/${tripId}/end`);
    expect(e1.body.closed).toBe(false);
    expect(e1.body.trip.me.claimStatus).toBe('verified'); // no expenses: nothing to check
    expect(e1.body.trip.permissions.canResume).toBe(true);
    const e2 = await sneha.post(`/trips/${tripId}/end`);
    expect(e2.body.closed).toBe(true);
    expect(e2.body.trip.trip.status).toBe('closed');
  });

  it('lets a member resume within 30 minutes (FR-END-09)', async () => {
    const rohan = as(await login('rohan'));
    const r = await rohan.post(`/trips/${tripId}/resume`);
    expect(r.status).toBe(200);
    expect(r.body.trip.status).not.toBe('closed');
    expect(r.body.me.running).toBe(true);
  });

  it('asks a late joiner when they started (FR-START-05)', async () => {
    const arjun = as(await login('arjun'));
    const trip = await arjun.post('/trips', { name: 'Walk-in demo', type: 'multi_day', purpose: 'client_meeting', scheduledStart: hoursFromNow(-1), tentativeEnd: hoursFromNow(3), primaryCity: 'Chennai', inviteeIds: [S.U.karthik.id] });
    expect(trip.status).toBe(201);
    expect(trip.body.trip.enteredAfterStart).toBe(true);
    expect(trip.body.me.running).toBe(true);
    const karthik = as(await login('karthik'));
    const need = await karthik.post(`/trips/${trip.body.trip.id}/respond`, { accept: true });
    expect(need.status).toBe(400);
    expect(need.body.error.code).toBe('start_choice_required');
    const ok = await karthik.post(`/trips/${trip.body.trip.id}/respond`, { accept: true, startChoice: 'scheduled' });
    expect(ok.body.started).toBe(true);
    expect(ok.body.trip.me.running).toBe(true);
  });
});

describe('server clock (NFR-14)', () => {
  it('marks a trip Extended past its tentative end and reminds running members every 12 hours', async () => {
    const soon = new Date(Date.now() + 5 * 24 * 3600_000);
    const r = await runScheduledWork(soon);
    expect(r).toMatchObject({ extended: expect.any(Number) });
    const divya = as(await login('divya'));
    const snap = await divya.get(`/trips/${S.T.mt}`);
    expect(snap.body.trip.status).toBe('extended');
    const notes = await divya.get('/notifications');
    expect(notes.body.items.some((n: { type: string; tripId: string }) => n.type === 'trip.planned_end' && n.tripId === S.T.mt)).toBe(true);
  });
});
