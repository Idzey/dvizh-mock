// Лист ожидания свободного разового мероприятия без мест (порт WaitlistService).
import { db, type Row } from "../db";
import { isOrganizationSuspended, isSingleCancelled } from "./policy";

/** Место в очереди: 1 — следующий; null — запись не в листе ожидания. */
export function waitlistPosition(registration: Row | undefined | null): number | null {
  if (!registration || registration.status !== "WAITLISTED") return null;
  return db.registrations.rows.filter((r) => r.eventId === registration.eventId && r.status === "WAITLISTED" && r.queuedAt < registration.queuedAt).length + 1;
}

/**
 * Освободились места — первые в очереди становятся участниками. Только пока запись вообще открыта:
 * опубликовано, свободный режим, не отменено, организация допущена, ещё не началось.
 */
export function promoteWaitlist(event: Row, now: number) {
  if (event.recurring || event.joinMode !== "FREE" || event.status !== "PUBLISHED" || isSingleCancelled(event) || isOrganizationSuspended(event) || event.startAt <= now) return;
  const queue = db.registrations.rows
    .filter((r) => r.eventId === event.id && r.status === "WAITLISTED")
    .sort((a, b) => a.queuedAt - b.queuedAt || String(a.id).localeCompare(String(b.id)));
  let confirmed = db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "CONFIRMED").length;
  for (const registration of queue) {
    if (event.capacity != null && confirmed >= event.capacity) return;
    Object.assign(registration, { status: "CONFIRMED", decidedAt: now, decidedById: null, queuedAt: null, updatedAt: now });
    db.registrations.touch();
    confirmed++;
  }
}
