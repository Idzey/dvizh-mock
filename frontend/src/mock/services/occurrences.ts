// Занятия мероприятий (порт OccurrenceService): у разового — одно занятие, у серии — по правилам расписания плюс разовые даты.
import { db, type Row } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../http";
import { newId } from "../util/ids";
import { dateKey } from "../util/time";
import { iso, userShort } from "./common";
import { watch } from "./changes";
import {
  attendBlockedReason, canCancelOccurrence, canConfirmOccurrence, canRescheduleOccurrence, cancelOccurrenceBlockedReason,
  changeOccurrenceBlockedReason, confirmOccurrenceBlockedReason, isOrganizer, manageOccurrencesBlockedReason, quorumStatus,
  registrationOf, unattendBlockedReason,
} from "./policy";
import { describeRule, describeRules, MAX_OCCURRENCES, type Expanded } from "./schedule";

export const EVENT_NOT_FOUND = "Мероприятие не найдено";
const NOT_FOUND = "Занятие не найдено";
const SCHEDULE_CHANGED = "Расписание изменено";
export const FAR_FUTURE = Date.parse("9999-12-31T00:00:00Z");

export const occurrencesOf = (eventId: string): Row[] =>
  db.eventOccurrences.rows.filter((o) => o.eventId === eventId).sort((a, b) => a.startAt - b.startAt);

export function findOccurrence(eventId: string, occurrenceId: string): Row {
  const o = db.eventOccurrences.get(occurrenceId);
  if (!o || o.eventId !== eventId) throw notFound(NOT_FOUND);
  return o;
}

const attendeesOf = (occurrenceId: string) => db.occurrenceAttendances.rows.filter((a) => a.occurrenceId === occurrenceId);

function newOccurrence(eventId: string, startAt: number, endAt: number | null, originalStartAt: number | null, source: string): Row {
  const now = Date.now();
  return db.eventOccurrences.insert({
    id: newId(), endAt, source, status: "SCHEDULED", eventId, startAt, createdAt: now, updatedAt: now, cancelledAt: null,
    confirmedAt: null, cancelReason: null, cancelledById: null, confirmedById: null, originalStartAt, rewardProcessedAt: null,
  });
}

const touchOccurrences = () => db.eventOccurrences.touch();

// ---------- ответы ----------

export function responses(event: Row, list: Row[], userId: string, now: number) {
  if (!list.length) return [];
  const myRegistration = registrationOf(event.id as string, userId);
  const countById = new Map<string, number>();
  let mine = new Set<string>();
  if (event.recurring) {
    for (const o of list) countById.set(o.id as string, attendeesOf(o.id as string).length);
    mine = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId && list.some((o) => o.id === a.occurrenceId)).map((a) => a.occurrenceId as string));
  } else {
    const confirmed = db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "CONFIRMED").length;
    for (const o of list) countById.set(o.id as string, confirmed);
    if (myRegistration?.status === "CONFIRMED") mine = new Set(list.map((o) => o.id as string));
  }
  return list.map((occurrence) => {
    const attending = mine.has(occurrence.id as string);
    const count = countById.get(occurrence.id as string) ?? 0;
    const blocked = attendBlockedReason(event, occurrence, userId, myRegistration, attending, count, now);
    const q = quorumStatus(event, occurrence, count);
    return {
      id: occurrence.id,
      eventId: occurrence.eventId,
      startAt: iso(occurrence.startAt),
      endAt: iso(occurrence.endAt),
      rescheduled: occurrence.originalStartAt != null && occurrence.originalStartAt !== occurrence.startAt,
      originalStartAt: iso(occurrence.originalStartAt),
      source: occurrence.source,
      status: occurrence.status,
      cancelReason: occurrence.cancelReason ?? null,
      attendeesCount: count,
      capacity: event.capacity ?? null,
      quorum: q ? { required: event.minParticipants, count, status: q, takesPlace: q !== "GATHERING" } : null,
      confirmedAt: iso(occurrence.confirmedAt),
      viewer: {
        attending,
        canAttend: blocked === null,
        attendBlockedReason: blocked,
        canUnattend: unattendBlockedReason(event, occurrence, attending, now) === null,
        canCancel: canCancelOccurrence(event, occurrence, userId, now),
        canReschedule: canRescheduleOccurrence(event, occurrence, userId, now),
        canConfirm: canConfirmOccurrence(event, occurrence, userId, now),
      },
    };
  });
}

const respond = (event: Row, occurrence: Row, userId: string, now: number) => responses(event, [occurrence], userId, now)[0];

/** Занятие разового мероприятия для его карточки; у серии — null. */
export function singleOccurrence(event: Row, userId: string, now: number) {
  if (event.recurring) return null;
  const first = occurrencesOf(event.id as string)[0];
  return first ? respond(event, first, userId, now) : null;
}

export function listOccurrences(eventId: string, userId: string, from: number | undefined, to: number | undefined, now: number) {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  const start = from ?? now;
  const end = to ?? FAR_FUTURE;
  if (end < start) throw badRequest("Конец периода должен быть не раньше начала");
  return responses(event, occurrencesOf(eventId).filter((o) => o.startAt >= start && o.startAt <= end), userId, now);
}

/** Ближайшее будущее занятие, которое состоится. */
export function nextOccurrence(event: Row, now: number) {
  const o = occurrencesOf(event.id as string).find((x) => x.status === "SCHEDULED" && x.startAt > now);
  return o ? { id: o.id, startAt: iso(o.startAt), endAt: iso(o.endAt) } : null;
}

export function scheduleResponse(event: Row) {
  if (!event.recurring) return null;
  const rules = db.eventScheduleRules.rows.filter((r) => r.eventId === event.id).sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    timeZone: event.timeZone,
    startDate: event.seriesStartDate,
    endDate: event.seriesEndDate,
    rules: rules.map((r) => ({ firstStart: r.firstStart, durationMinutes: r.durationMinutes, rrule: r.rrule, description: describeRule(r.firstStart, r.rrule) })),
    description: describeRules(rules),
  };
}

/** Описания расписаний для списка серий: eventId → «по вторникам в 20:00». */
export function descriptions(events: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  const series = new Set(events.filter((e) => e.recurring).map((e) => e.id as string));
  if (!series.size) return out;
  const byEvent = new Map<string, Row[]>();
  for (const r of db.eventScheduleRules.rows) {
    if (!series.has(r.eventId)) continue;
    byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r]);
  }
  for (const [id, rules] of byEvent) out.set(id, describeRules(rules.sort((a, b) => a.sortOrder - b.sortOrder)));
  return out;
}

// ---------- изменения занятий ----------

function checkTime(event: Row, startAt: number, endAt: number | null, now: number) {
  if (startAt <= now) throw badRequest("Занятие должно быть в будущем");
  if (endAt !== null && endAt <= startAt) throw badRequest("Окончание должно быть позже начала");
  const day = dateKey(startAt, event.timeZone);
  if (day < event.seriesStartDate || day > event.seriesEndDate) throw badRequest("Дата занятия должна попадать в границы серии");
}

const lockEvent = (eventId: string, userId: string): Row => {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  watch(eventId, userId);
  return event;
};

function organizerLocked(eventId: string, userId: string, forbiddenText: string): Row {
  const event = lockEvent(eventId, userId);
  if (!isOrganizer(event, userId)) throw forbidden(forbiddenText);
  return event;
}

function manageable(eventId: string, userId: string): Row {
  const event = organizerLocked(eventId, userId, "Менять занятия может только организатор");
  const blocked = manageOccurrencesBlockedReason(event);
  if (blocked) throw conflict(blocked);
  return event;
}

/** startAt/endAt серии — первое занятие, которое состоится (а если все отменены — просто первое). */
export function updateSpan(event: Row) {
  const first = [...occurrencesOf(event.id as string)].sort(
    (a, b) => Number(a.status !== "SCHEDULED") - Number(b.status !== "SCHEDULED") || a.startAt - b.startAt,
  )[0];
  if (first) {
    event.startAt = first.startAt;
    event.endAt = first.endAt ?? null;
    db.events.touch();
  }
}

/** После сохранения мероприятия приводит занятия к форме: разовому — одно занятие, серии — правила и занятия по ним. */
export function applyOccurrences(event: Row, plan: Expanded | null, now: number) {
  if (!plan) {
    const existing = occurrencesOf(event.id as string);
    if (!existing.length) newOccurrence(event.id as string, event.startAt, event.endAt ?? null, null, "SINGLE");
    else {
      existing[0].startAt = event.startAt;
      existing[0].endAt = event.endAt ?? null;
      existing[0].updatedAt = now;
      touchOccurrences();
    }
    return;
  }
  db.eventScheduleRules.removeWhere((r) => r.eventId === event.id);
  plan.rules.forEach((rule, i) =>
    db.eventScheduleRules.insert({
      id: newId(), rrule: rule.rrule, eventId: event.id, createdAt: now, sortOrder: i, updatedAt: now,
      firstStart: rule.firstStart, durationMinutes: rule.durationMinutes,
    }),
  );
  syncSeries(event, plan, now);
  updateSpan(event);
}

/**
 * Прошедшие занятия не трогаем. Будущие из правил с тем же исходным временем остаются (с отметками, переносом, отменой).
 * Пропавшие из расписания: с отметками — отменяются («Расписание изменено»), без отметок — удаляются.
 */
function syncSeries(event: Row, plan: Expanded, now: number) {
  const slotByStart = new Map(plan.slots.map((s) => [s.start, s]));
  const knownOriginals = new Set<number>();
  const scheduledStarts = new Set<number>();
  for (const occurrence of occurrencesOf(event.id as string)) {
    if (occurrence.source === "RULE" && occurrence.startAt > now) {
      const slot = slotByStart.get(occurrence.originalStartAt);
      if (!slot) {
        if (!attendeesOf(occurrence.id as string).length) {
          db.eventOccurrences.remove(occurrence.id as string);
          continue;
        }
        if (occurrence.status === "SCHEDULED") cancelRow(occurrence, SCHEDULE_CHANGED, now, null);
      } else if (occurrence.status === "SCHEDULED" && occurrence.startAt === occurrence.originalStartAt && (occurrence.endAt ?? null) !== slot.end) {
        occurrence.startAt = slot.start;
        occurrence.endAt = slot.end;
        touchOccurrences();
      }
    }
    if (occurrence.originalStartAt != null) knownOriginals.add(occurrence.originalStartAt);
    if (occurrence.status === "SCHEDULED") scheduledStarts.add(occurrence.startAt);
  }
  for (const slot of plan.slots) {
    if (slot.start <= now || knownOriginals.has(slot.start) || scheduledStarts.has(slot.start)) continue;
    newOccurrence(event.id as string, slot.start, slot.end, slot.start, "RULE");
  }
}

function cancelRow(occurrence: Row, reason: string | null, at: number, byId: string | null) {
  occurrence.status = "CANCELLED";
  occurrence.cancelReason = reason;
  occurrence.cancelledAt = at;
  occurrence.cancelledById = byId;
  occurrence.updatedAt = at;
  touchOccurrences();
}

export function attend(eventId: string, occurrenceId: string, userId: string, now: number) {
  const event = lockEvent(eventId, userId);
  const occurrence = findOccurrence(eventId, occurrenceId);
  if (!db.occurrenceAttendances.find((a) => a.occurrenceId === occurrenceId && a.userId === userId)) {
    const blocked = attendBlockedReason(event, occurrence, userId, registrationOf(eventId, userId), false, attendeesOf(occurrenceId).length, now);
    if (blocked) throw conflict(blocked);
    db.occurrenceAttendances.insert({ id: newId(), userId, eventId, createdAt: now, updatedAt: now, occurrenceId });
  }
  return respond(event, occurrence, userId, now);
}

export function unattend(eventId: string, occurrenceId: string, userId: string, now: number) {
  const event = lockEvent(eventId, userId);
  const occurrence = findOccurrence(eventId, occurrenceId);
  const mine = db.occurrenceAttendances.find((a) => a.occurrenceId === occurrenceId && a.userId === userId);
  if (mine || !event.recurring) {
    const blocked = unattendBlockedReason(event, occurrence, !!mine, now);
    if (blocked) throw conflict(blocked);
    db.occurrenceAttendances.remove(mine?.id as string);
  }
  return respond(event, occurrence, userId, now);
}

export function addOccurrence(eventId: string, userId: string, startAt: number, endAt: number | null, now: number) {
  const event = manageable(eventId, userId);
  if (endAt === null) throw badRequest("Укажите окончание занятия");
  checkTime(event, startAt, endAt, now);
  const all = occurrencesOf(eventId);
  if (all.some((o) => o.status === "SCHEDULED" && o.startAt === startAt)) throw conflict("В это время у серии уже есть занятие");
  if (all.length >= MAX_OCCURRENCES) throw conflict(`В серии не может быть больше ${MAX_OCCURRENCES} занятий`);
  const added = newOccurrence(eventId, startAt, endAt, null, "EXTRA");
  updateSpan(event);
  return respond(event, added, userId, now);
}

export function rescheduleOccurrence(eventId: string, occurrenceId: string, userId: string, startAt: number, endAtIn: number | null, now: number) {
  const event = manageable(eventId, userId);
  const occurrence = findOccurrence(eventId, occurrenceId);
  const blocked = changeOccurrenceBlockedReason(occurrence, now);
  if (blocked) throw conflict(blocked);
  let endAt = endAtIn;
  if (endAt === null && occurrence.endAt != null) endAt = startAt + (occurrence.endAt - occurrence.startAt);
  checkTime(event, startAt, endAt, now);
  if (startAt !== occurrence.startAt && occurrencesOf(eventId).some((o) => o.status === "SCHEDULED" && o.startAt === startAt)) {
    throw conflict("В это время у серии уже есть занятие");
  }
  occurrence.startAt = startAt;
  occurrence.endAt = endAt;
  occurrence.updatedAt = now;
  touchOccurrences();
  updateSpan(event);
  return respond(event, occurrence, userId, now);
}

export function cancelOccurrence(eventId: string, occurrenceId: string, userId: string, reason: string | null, now: number) {
  const event = organizerLocked(eventId, userId, "Отменять занятия может только организатор");
  const occurrence = findOccurrence(eventId, occurrenceId);
  const blocked = cancelOccurrenceBlockedReason(event, occurrence, now);
  if (blocked) throw conflict(blocked);
  cancelRow(occurrence, reason, now, userId);
  if (event.recurring) updateSpan(event);
  return respond(event, occurrence, userId, now);
}

export function confirmOccurrence(eventId: string, occurrenceId: string, userId: string, now: number) {
  const event = organizerLocked(eventId, userId, "Подтверждать занятия может только организатор");
  const occurrence = findOccurrence(eventId, occurrenceId);
  const blocked = confirmOccurrenceBlockedReason(event, occurrence, now);
  if (blocked) throw conflict(blocked);
  if (!occurrence.confirmedAt) {
    occurrence.confirmedAt = now;
    occurrence.confirmedById = userId;
    occurrence.updatedAt = now;
    touchOccurrences();
  }
  return respond(event, occurrence, userId, now);
}

/** Кто придёт на занятие — только организатору. У разового это подтверждённые участники. */
export function attendees(eventId: string, occurrenceId: string, userId: string) {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  if (!isOrganizer(event, userId)) throw forbidden("Кто придёт, видит только организатор");
  findOccurrence(eventId, occurrenceId);
  const ids = event.recurring
    ? attendeesOf(occurrenceId).map((a) => a.userId as string)
    : db.registrations.rows.filter((r) => r.eventId === eventId && r.status === "CONFIRMED").sort((a, b) => a.createdAt - b.createdAt).map((r) => r.userId as string);
  return ids.map((id) => userShort(db.users.get(id)));
}

/** Занятия для календаря .ics: будущие и неотменённые; у серии — мои отметки, а если их нет — все будущие. */
export function calendarOccurrences(event: Row, userId: string, now: number): Row[] {
  const upcoming = occurrencesOf(event.id as string).filter((o) => o.status === "SCHEDULED" && o.startAt > now);
  if (!event.recurring || !upcoming.length) return upcoming;
  const mine = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId).map((a) => a.occurrenceId as string));
  const marked = upcoming.filter((o) => mine.has(o.id as string));
  return marked.length ? marked : upcoming;
}

/** Самое заполненное будущее занятие серии: лимит мест нельзя сделать меньше. */
export function maxFutureAttendance(eventId: string, now: number): number {
  let max = 0;
  for (const o of occurrencesOf(eventId)) {
    if (o.startAt > now) max = Math.max(max, attendeesOf(o.id as string).length);
  }
  return max;
}

/** Мои ближайшие отмеченные занятия в сериях из списка: eventId → занятие. */
export function myNext(userId: string, events: Row[], now: number): Map<string, { id: string; startAt: string | null; endAt: string | null }> {
  const out = new Map<string, { id: string; startAt: string | null; endAt: string | null }>();
  const series = new Set(events.filter((e) => e.recurring).map((e) => e.id as string));
  if (!series.size) return out;
  const mine = db.occurrenceAttendances.rows.filter((a) => a.userId === userId && series.has(a.eventId));
  for (const a of mine) {
    const o = db.eventOccurrences.get(a.occurrenceId);
    if (!o || o.status !== "SCHEDULED" || o.startAt <= now) continue;
    const cur = out.get(a.eventId);
    if (!cur || Date.parse(cur.startAt as string) > o.startAt) out.set(a.eventId, { id: o.id, startAt: iso(o.startAt), endAt: iso(o.endAt) });
  }
  return out;
}

/** Участник вышел из серии или исключён: будущие отметки снимаются, прошлые остаются. */
export function dropFutureAttendance(eventId: string, userId: string, now: number) {
  db.occurrenceAttendances.removeWhere((a) => {
    if (a.eventId !== eventId || a.userId !== userId) return false;
    const o = db.eventOccurrences.get(a.occurrenceId);
    return !!o && o.startAt > now;
  });
}
