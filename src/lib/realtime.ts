import type { Server } from 'socket.io';

/** Live channel to both apps (FR-WEB-03, NFR-13). Rooms: finance, user:<id>, trip:<id>. */
let io: Server | null = null;
export function setIo(server: Server | null) { io = server; }

export function emitToUser(userId: string, event: string, payload: unknown) { io?.to(`user:${userId}`).emit(event, payload); }
/** Only the sockets of one app: phone notifications stay on phones, console notifications on the web (channel app or web). */
export function emitToUserClient(userId: string, client: 'mobile' | 'web', event: string, payload: unknown) { io?.to(`user:${userId}:${client}`).emit(event, payload); }
export function emitToFinance(event: string, payload: unknown) { io?.to('finance').emit(event, payload); }
export function emitToTrip(tripId: string, event: string, payload: unknown) { io?.to(`trip:${tripId}`).emit(event, payload); }
/** A deactivated account loses its live connections at once (FR-ROLE-08). */
export function disconnectUser(userId: string) { io?.in(`user:${userId}`).disconnectSockets(true); }

/** One call for "something on this trip changed": finance screens and members' open trip views refresh. */
export function tripChanged(tripId: string, kind: string, extra: Record<string, unknown> = {}) {
  const payload = { tripId, kind, ...extra, at: new Date().toISOString() };
  emitToFinance('trip.changed', payload);
  emitToTrip(tripId, 'trip.changed', payload);
}
