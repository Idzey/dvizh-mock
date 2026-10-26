// «Бублик подсказывает»: когда выходить на ближайшее занятие и личное напоминание (порт LeaveTipService).
// Время в пути — оценка по расстоянию (маршрутов 2ГИС в демо нет), как у бэкенда без ключа.
import { db, type Row } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { newId } from "../util/ids";
import { HOUR, timeText, ZONE } from "../util/time";
import { iso } from "./common";
import { publish } from "./notify";
import { isOrganizationSuspended, registrationOf } from "./policy";

const BUFFER_MINUTES = 5;
const NO_HOME_MINUTES = 60;
const ONLINE_MINUTES = 15;
const MAX_AHEAD = 12 * HOUR;
const WALK_LIMIT_MINUTES = 25;
const HOW: Record<string, string> = { WALK: "пешком", BUS: "на автобусе", CAR: "на машине" };

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const roundUp = (minutes: number) => Math.max(5, Math.ceil(minutes / 5) * 5);

/** Минуты в пути по каждому способу: пешком, на автобусе, на машине. */
function travelMinutes(distanceKm: number): Record<"WALK" | "BUS" | "CAR", number> {
  const km = distanceKm * 1.3;
  return { WALK: roundUp((km / 5) * 60), BUS: roundUp((km / 20) * 60 + 10), CAR: roundUp((km / 30) * 60 + 5) };
}

const zoneOf = (event: Row) => event.timeZone ?? ZONE;

function place(event: Row): string | null {
  if (event.format === "ONLINE") return null;
  const address = (event.address ?? "").trim();
  if (address) return address;
  return (event.locationNote ?? "").trim() || null;
}

/** Подтверждённая запись; у серии — ещё и отметка «приду» на это занятие. */
function participant(userId: string, event: Row, occurrence: Row): boolean {
  const confirmed = registrationOf(event.id as string, userId)?.status === "CONFIRMED";
  return confirmed && (!event.recurring || db.occurrenceAttendances.rows.some((a) => a.occurrenceId === occurrence.id && a.userId === userId));
}

/** Ближайшее будущее занятие среди моих подтверждённых записей. */
function nearest(userId: string, now: number): { event: Row; occurrence: Row } | null {
  let best: { event: Row; occurrence: Row } | null = null;
  for (const r of db.registrations.rows) {
    if (r.userId !== userId || r.status !== "CONFIRMED") continue;
    const event = db.events.get(r.eventId);
    if (!event || event.status !== "PUBLISHED" || isOrganizationSuspended(event)) continue;
    for (const o of db.eventOccurrences.rows) {
      if (o.eventId !== event.id || o.status !== "SCHEDULED" || o.startAt <= now) continue;
      if (event.recurring && !db.occurrenceAttendances.rows.some((a) => a.occurrenceId === o.id && a.userId === userId)) continue;
      if (!best || o.startAt < best.occurrence.startAt) best = { event, occurrence: o };
    }
  }
  return best;
}

const reminderOf = (userId: string, occurrenceId: string) => db.personalReminders.find((r) => r.userId === userId && r.occurrenceId === occurrenceId);

const reminderResponse = (r: Row) => ({
  status: r.status,
  dueAt: iso(r.dueAt),
  travelMinutes: r.travelMinutes ?? null,
  travelMode: r.travelMode ?? null,
});

/** Подсказка на ближайшее занятие; null — подсказки нет. */
export function leaveTip(userId: string, now: number) {
  const user = db.users.get(userId) as Row;
  if (user.systemRole !== "USER") return null;
  const prefs = db.userPreferences.find((p) => p.userId === userId);
  if (prefs && !prefs.reminders) return null;
  const slot = nearest(userId, now);
  if (!slot) return null;
  const { event, occurrence } = slot;
  const start = occurrence.startAt;
  const stored = reminderOf(userId, occurrence.id as string);
  const reminder = stored && stored.status !== "CANCELLED" && stored.expectedStartAt === start ? reminderResponse(stored) : null;
  const offline = event.format === "OFFLINE" && event.lat != null && event.lon != null;
  const home = prefs && prefs.homeLat != null ? { lat: prefs.homeLat, lon: prefs.homeLon } : null;
  const base = {
    eventId: event.id, occurrenceId: occurrence.id, title: event.title, startAt: iso(start), format: event.format, place: place(event),
    lat: event.lat ?? null, lon: event.lon ?? null, home,
  };
  if (!offline || !home) {
    const minutes = offline ? NO_HOME_MINUTES : ONLINE_MINUTES;
    return { ...base, distanceKm: null, estimates: [], recommendedMode: "NONE", suggestedRemindAt: iso(start - minutes * 60_000), reminder };
  }
  const distance = haversineKm(home.lat, home.lon, event.lat, event.lon);
  const minutes = travelMinutes(distance);
  const estimates = (["WALK", "BUS", "CAR"] as const).map((mode) => ({ mode, minutes: minutes[mode], available: true, note: null, source: "ESTIMATE" }));
  const recommended = minutes.WALK <= WALK_LIMIT_MINUTES ? "WALK" : "BUS";
  return {
    ...base, distanceKm: Math.round(distance * 10) / 10, estimates, recommendedMode: recommended,
    suggestedRemindAt: iso(start - (minutes[recommended] + BUFFER_MINUTES) * 60_000), reminder,
  };
}

function requireParticipant(userId: string, event: Row, occurrence: Row, now: number) {
  if (!participant(userId, event, occurrence)) throw conflict("Напоминание можно поставить только на занятие, куда вы идёте");
  if (event.status !== "PUBLISHED" || isOrganizationSuspended(event) || occurrence.status !== "SCHEDULED") throw conflict("Занятие отменено или снято с публикации");
  if (occurrence.startAt <= now) throw conflict("Занятие уже началось");
}

function load(occurrenceId: string): { event: Row; occurrence: Row } {
  const occurrence = db.eventOccurrences.get(occurrenceId);
  const event = occurrence && db.events.get(occurrence.eventId);
  if (!occurrence || !event) throw notFound("Занятие не найдено");
  return { event, occurrence };
}

function save(userId: string, event: Row, occurrence: Row, dueAt: number | null, status: string, minutes: number | null, mode: string | null, now: number) {
  const patch = { expectedStartAt: occurrence.startAt, dueAt, status, travelMinutes: minutes, travelMode: mode, updatedAt: now };
  const existing = reminderOf(userId, occurrence.id as string);
  if (existing) {
    Object.assign(existing, patch);
    db.personalReminders.touch();
    return existing;
  }
  return db.personalReminders.insert({ id: newId(), userId, eventId: event.id, occurrenceId: occurrence.id, createdAt: now, ...patch });
}

export function setReminder(userId: string, occurrenceId: string, r: { dueAt: string; travelMinutes?: number; travelMode: string }, now: number) {
  const { event, occurrence } = load(occurrenceId);
  requireParticipant(userId, event, occurrence, now);
  const dueAt = Date.parse(r.dueAt);
  if (dueAt <= now) throw badRequest("Время напоминания уже прошло");
  if (dueAt >= occurrence.startAt) throw badRequest("Напомнить нужно до начала занятия");
  if (dueAt < occurrence.startAt - MAX_AHEAD) throw badRequest("Напомнить можно не раньше чем за 12 часов до начала");
  const minutes = r.travelMode === "NONE" ? null : (r.travelMinutes ?? null);
  return reminderResponse(save(userId, event, occurrence, dueAt, "SCHEDULED", minutes, r.travelMode, now));
}

export function cancelReminder(userId: string, occurrenceId: string, now: number) {
  const reminder = reminderOf(userId, occurrenceId);
  if (!reminder || reminder.status !== "SCHEDULED") throw notFound("Напоминание не найдено");
  Object.assign(reminder, { status: "CANCELLED", updatedAt: now });
  db.personalReminders.touch();
}

/** «Не надо»: подсказку на это занятие больше не показываем (и поставленное напоминание снимается). */
export function dismissTip(userId: string, occurrenceId: string, now: number) {
  const { event, occurrence } = load(occurrenceId);
  requireParticipant(userId, event, occurrence, now);
  save(userId, event, occurrence, null, "DISMISSED", null, null, now);
}

/** Личные напоминания, которым пора уйти: отправить или отменить, если потеряли смысл. */
export function processDueReminders(now: number) {
  const GRACE = 10 * 60_000;
  for (const reminder of db.personalReminders.rows.filter((r) => r.status === "SCHEDULED" && r.dueAt <= now)) {
    const occurrence = db.eventOccurrences.get(reminder.occurrenceId);
    const event = db.events.get(reminder.eventId);
    const actual =
      !!occurrence && !!event && participant(reminder.userId, event, occurrence) && event.status === "PUBLISHED" && !isOrganizationSuspended(event) &&
      occurrence.status === "SCHEDULED" && occurrence.startAt === reminder.expectedStartAt && occurrence.startAt > now && reminder.dueAt + GRACE >= now;
    if (!actual || !event || !occurrence) {
      Object.assign(reminder, { status: "CANCELLED", updatedAt: now });
      db.personalReminders.touch();
      continue;
    }
    const time = timeText(occurrence.startAt, zoneOf(event));
    const how = reminder.travelMode && reminder.travelMode !== "NONE" ? HOW[reminder.travelMode] : null;
    const title = how ? "Пора выходить" : "Скоро встреча";
    const body = !how || reminder.travelMinutes == null
      ? `${event.title} в ${time}\nДо начала ${Math.round((occurrence.startAt - now) / 60_000)} мин.`
      : `${event.title} в ${time}\nДо места ~${reminder.travelMinutes} мин ${how}`;
    publish([{
      key: `personal-reminder:${reminder.id}:${Math.floor(reminder.dueAt / 1000)}`, recipients: [reminder.userId], type: "REMINDER", category: "REMINDERS",
      title, body, targetPath: `/events/${event.id}`, eventId: event.id as string, occurrenceId: occurrence.id as string, expectedStartAt: occurrence.startAt,
    }], now);
    Object.assign(reminder, { status: "SENT", updatedAt: now });
    db.personalReminders.touch();
  }
}

