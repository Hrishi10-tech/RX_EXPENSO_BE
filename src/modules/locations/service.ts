/** Locations within a trip (SRS §4.6). */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { Ctx } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { tripChanged } from '../../lib/realtime.js';
import { istDate } from '../../lib/time.js';
import { getMembers, requireMemberAccess, tripIsLive, type Trip } from '../domain.js';

const { locations, expenses } = schema;
export type LocationRow = typeof locations.$inferSelect;

export interface LocationInput {
  clientId?: string | null; city: string; venue?: string | null; address?: string | null; lat?: number | null; lng?: number | null;
  arrivalDate: string; departureDate: string; notes?: string | null; confirmOverlap?: boolean;
}

/**
 * FR-LOC-01: dates fall from the earliest actual start (or the scheduled start before anyone starts) to the
 * latest actual end or, while the trip runs, the later of the tentative end and today.
 */
export async function tripWindow(ctx: Ctx, trip: Trip) {
  const ms = (await getMembers(ctx.tx, trip.id)).filter(m => m.joinStatus === 'accepted');
  const starts = ms.map(m => m.actualStart).filter((d): d is Date => !!d);
  const from = istDate(starts.length ? new Date(Math.min(...starts.map(d => d.getTime()), trip.scheduledStart.getTime())) : trip.scheduledStart);
  let to: string;
  if (trip.status === 'closed') {
    const ends = ms.map(m => m.actualEnd).filter((d): d is Date => !!d);
    to = istDate(new Date(Math.max(...ends.map(d => d.getTime()), trip.tentativeEnd.getTime())));
  } else {
    const t = istDate(trip.tentativeEnd), today = istDate(ctx.now);
    to = t > today ? t : today;
  }
  return { from, to };
}

async function validate(ctx: Ctx, trip: Trip, input: LocationInput, exceptId?: string) {
  const errs: Array<{ field: string; message: string }> = [];
  if (!input.city.trim()) errs.push({ field: 'city', message: 'Enter the city.' });
  if (input.departureDate < input.arrivalDate) errs.push({ field: 'departureDate', message: 'Departure is before arrival.' });
  const w = await tripWindow(ctx, trip);
  if (input.arrivalDate < w.from || input.arrivalDate > w.to) errs.push({ field: 'arrivalDate', message: `Pick a date between ${w.from} and ${w.to}.` });
  if (input.departureDate < w.from || input.departureDate > w.to) errs.push({ field: 'departureDate', message: `Pick a date between ${w.from} and ${w.to}.` });
  if (errs.length) throw badRequest('validation', 'Some fields need attention.', errs);
  if (!input.confirmOverlap) {
    const overl = await ctx.tx.select().from(locations).where(and(eq(locations.tripId, trip.id), isNull(locations.deletedAt),
      sql`${locations.arrivalDate} < ${input.departureDate}::date`, sql`${locations.departureDate} > ${input.arrivalDate}::date`,
      exceptId ? sql`${locations.id} <> ${exceptId}` : sql`true`));
    if (overl.length) {
      // FR-LOC-07: a warning the member may confirm past, with a suggested fix.
      const o = overl[0];
      throw conflict('location_overlap', `These dates overlap ${o.city} (${o.arrivalDate} to ${o.departureDate}).`, {
        overlaps: overl.map(x => ({ id: x.id, city: x.city, arrivalDate: x.arrivalDate, departureDate: x.departureDate })),
        suggestion: { locationId: o.id, city: o.city, departureDate: input.arrivalDate },
      });
    }
  }
}

export async function addLocation(ctx: Ctx, tripId: string, input: LocationInput) {
  const { trip } = await requireMemberAccess(ctx, tripId, true);
  if (input.clientId) {
    const ex = (await ctx.tx.select().from(locations).where(and(eq(locations.tripId, tripId), eq(locations.clientId, input.clientId))))[0];
    if (ex) return ex;
  }
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'Locations can be added while the trip is scheduled or running.');
  await validate(ctx, trip, input);
  const [l] = await ctx.tx.insert(locations).values({
    tripId, clientId: input.clientId ?? null, city: input.city.trim(), venue: input.venue?.trim() || null, address: input.address?.trim() || null,
    lat: input.lat ?? null, lng: input.lng ?? null, arrivalDate: input.arrivalDate, departureDate: input.departureDate, notes: input.notes?.trim() || null,
    addedBy: ctx.actor.id!, createdAt: ctx.now, updatedAt: ctx.now,
  }).returning();
  await audit(ctx, { action: 'location.add', entity: 'location', entityId: l.id, tripId, after: l });
  ctx.after.push(() => tripChanged(tripId, 'location'));
  return l;
}

export async function updateLocation(ctx: Ctx, locationId: string, input: Partial<LocationInput>) {
  const l = (await ctx.tx.select().from(locations).where(and(eq(locations.id, locationId), isNull(locations.deletedAt))))[0];
  if (!l) throw notFound('Location');
  const { trip } = await requireMemberAccess(ctx, l.tripId, true);
  if (l.addedBy !== ctx.actor.id && trip.ownerId !== ctx.actor.id) throw forbidden('Only the member who added this location, or the owner, can change it.');
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'This trip is closed or cancelled.');
  const merged = { city: input.city ?? l.city, venue: input.venue === undefined ? l.venue : input.venue, address: input.address === undefined ? l.address : input.address, lat: input.lat === undefined ? l.lat : input.lat, lng: input.lng === undefined ? l.lng : input.lng, arrivalDate: input.arrivalDate ?? l.arrivalDate, departureDate: input.departureDate ?? l.departureDate, notes: input.notes === undefined ? l.notes : input.notes, confirmOverlap: input.confirmOverlap };
  await validate(ctx, trip, merged, l.id);
  const { confirmOverlap: _c, ...vals } = merged;
  const [u] = await ctx.tx.update(locations).set({ ...vals, updatedAt: ctx.now }).where(eq(locations.id, l.id)).returning();
  await audit(ctx, { action: 'location.update', entity: 'location', entityId: l.id, tripId: l.tripId, before: l, after: u });
  ctx.after.push(() => tripChanged(l.tripId, 'location'));
  return u;
}

/** FR-LOC-06: never delete a location in use (even by expenses the viewer cannot see) or the last one. */
export async function deleteLocation(ctx: Ctx, locationId: string) {
  const l = (await ctx.tx.select().from(locations).where(and(eq(locations.id, locationId), isNull(locations.deletedAt))))[0];
  if (!l) throw notFound('Location');
  const { trip } = await requireMemberAccess(ctx, l.tripId, true);
  if (l.addedBy !== ctx.actor.id && trip.ownerId !== ctx.actor.id) throw forbidden('Only the member who added this location, or the owner, can delete it.');
  const used = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.locationId, l.id), isNull(expenses.deletedAt)));
  if (Number(used[0].c) > 0) throw conflict('location_in_use', `${l.city} is in use, so it cannot be deleted.`);
  const count = await ctx.tx.select({ c: sql<number>`count(*)` }).from(locations).where(and(eq(locations.tripId, l.tripId), isNull(locations.deletedAt)));
  if (Number(count[0].c) <= 1) throw conflict('last_location', 'A trip always keeps at least one location.');
  await ctx.tx.update(locations).set({ deletedAt: ctx.now, updatedAt: ctx.now }).where(eq(locations.id, l.id));
  await audit(ctx, { action: 'location.delete', entity: 'location', entityId: l.id, tripId: l.tripId, before: l });
  ctx.after.push(() => tripChanged(l.tripId, 'location'));
}

export async function tripLocations(ctx: Ctx, tripId: string) {
  return ctx.tx.select().from(locations).where(and(eq(locations.tripId, tripId), isNull(locations.deletedAt))).orderBy(asc(locations.arrivalDate), asc(locations.createdAt));
}
