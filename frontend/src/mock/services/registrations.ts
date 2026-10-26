// Запись на мероприятие и решения организатора (порт RegistrationService).
import { db, type Row } from "../db";
import { conflict, forbidden, notFound } from "../http";
import { isMainAccount, schedule } from "../life/jobs";
import { newId } from "../util/ids";
import { watch } from "./changes";
import { iso, userShort } from "./common";
import { summaries } from "./events";
import { dropFutureAttendance, EVENT_NOT_FOUND, myNext } from "./occurrences";
import {
  approveBlockedReason, cancelBlockedReason, canManage, isOrganizer, joinAs, manageConflictReason, registerBlockedReason,
  registrationOf, rejectBlockedReason,
} from "./policy";
import { promoteWaitlist, waitlistPosition } from "./waitlist";

const requireEvent = (id: string): Row => {
  const e = db.events.get(id);
  if (!e) throw notFound(EVENT_NOT_FOUND);
  return e;
};

const confirmedCount = (eventId: string) => db.registrations.rows.filter((r) => r.eventId === eventId && r.status === "CONFIRMED").length;

export const registrationResponse = (r: Row) => ({
  id: r.id,
  eventId: r.eventId,
  userId: r.userId,
  status: r.status,
  message: r.message ?? null,
  decisionReason: r.decisionReason ?? null,
  decidedAt: iso(r.decidedAt),
  decidedById: r.decidedById ?? null,
  createdAt: iso(r.createdAt),
});

/**
 * FREE — сразу CONFIRMED, а если мест нет — WAITLISTED; REQUEST — PENDING. После отмены та же строка переиспользуется.
 * У серии это вступление в серию: на занятия участник отмечается отдельно.
 */
export function createRegistration(eventId: string, userId: string, message: string | null | undefined, now: number) {
  const event = requireEvent(eventId);
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  watch(eventId, userId);
  const mine = registrationOf(eventId, userId);
  const count = confirmedCount(eventId);
  const blocked = registerBlockedReason(event, user.systemRole, userId, mine, count, now);
  if (blocked) throw conflict(blocked);
  const status = joinAs(event, count);
  const decidedAt = status === "CONFIRMED" ? now : null;
  const queuedAt = status === "WAITLISTED" ? now : null;
  const text = message ?? null;
  let saved: Row;
  if (mine) {
    Object.assign(mine, { status, message: text, decidedAt, queuedAt, decisionReason: null, decidedById: null, updatedAt: now });
    db.registrations.touch();
    saved = mine;
  } else {
    saved = db.registrations.insert({
      id: newId(), status, userId, eventId, message: text, queuedAt, createdAt: now, decidedAt, updatedAt: now, decidedById: null, decisionReason: null,
    });
  }
  // «живой мир»: организатор из массовых аккаунтов принимает заявку через полминуты
  if (status === "PENDING" && !isMainAccount(event.authorId)) schedule("approve-registration", 20_000, { registrationId: saved.id });
  return registrationResponse(saved);
}

/** Отмена своей записи или заявки; повторное нажатие ничего не меняет. */
export function cancelRegistration(eventId: string, userId: string, now: number) {
  const event = requireEvent(eventId);
  const mine = registrationOf(eventId, userId);
  if (!mine) throw notFound("Вы не записаны на это мероприятие");
  if (mine.status === "CANCELLED") return registrationResponse(mine);
  watch(eventId, userId);
  const blocked = cancelBlockedReason(event, mine, now);
  if (blocked) throw conflict(blocked);
  const freedSeat = mine.status === "CONFIRMED";
  Object.assign(mine, { status: "CANCELLED", decidedAt: now, decidedById: userId, updatedAt: now });
  db.registrations.touch();
  if (event.recurring) dropFutureAttendance(eventId, userId, now);
  if (freedSeat) promoteWaitlist(event, now);
  return registrationResponse(mine);
}

export function listForEvent(eventId: string, userId: string, status: string | undefined) {
  const event = requireEvent(eventId);
  if (!isOrganizer(event, userId)) throw forbidden("Заявки видит только организатор");
  return db.registrations.rows
    .filter((r) => r.eventId === eventId && (!status || r.status === status))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      participant: userShort(db.users.get(r.userId)),
      status: r.status,
      message: r.message ?? null,
      decisionReason: r.decisionReason ?? null,
      decidedAt: iso(r.decidedAt),
      createdAt: iso(r.createdAt),
      queuedAt: iso(r.queuedAt),
    }));
}

/** Заявка + её мероприятие; решать может только организатор (админ — нет). */
function managed(registrationId: string, userId: string): { registration: Row; event: Row } {
  const registration = db.registrations.get(registrationId);
  if (!registration) throw notFound("Заявка не найдена");
  const event = requireEvent(registration.eventId);
  if (!isOrganizer(event, userId)) throw forbidden("Решение по заявке принимает только организатор");
  if (!canManage(event, userId)) throw conflict(manageConflictReason(event, "Мероприятие удалено, решать заявки нельзя"));
  watch(event.id as string, userId);
  return { registration, event };
}

function decide(registration: Row, status: string, reason: string | null, userId: string, now: number) {
  Object.assign(registration, { status, decisionReason: reason, decidedAt: now, decidedById: userId, updatedAt: now });
  db.registrations.touch();
  return registrationResponse(registration);
}

/** Подтвердить можно и ранее отклонённую заявку — так организатор исправляет ошибку. */
export function approveRegistration(registrationId: string, userId: string, now: number) {
  const { registration, event } = managed(registrationId, userId);
  if (registration.status === "CONFIRMED") return registrationResponse(registration);
  const blocked = approveBlockedReason(event, registration, confirmedCount(event.id as string), now);
  if (blocked) throw conflict(blocked);
  return decide(registration, "CONFIRMED", null, userId, now);
}

/** Отклонить можно и подтверждённого (исключить из участников); причину участник увидит в своей записи. */
export function rejectRegistration(registrationId: string, userId: string, reason: string | null, now: number) {
  const { registration, event } = managed(registrationId, userId);
  const blocked = rejectBlockedReason(registration);
  if (blocked) throw conflict(blocked);
  const freedSeat = registration.status === "CONFIRMED";
  const response = decide(registration, "REJECTED", reason, userId, now);
  if (freedSeat) promoteWaitlist(event, now);
  if (event.recurring) dropFutureAttendance(event.id as string, registration.userId, now);
  return response;
}

/** Мои записи со статусом мероприятия: снятое с публикации тоже видно. У серии — моё ближайшее отмеченное занятие. */
export function myRegistrations(userId: string, status: string | undefined, when: string | undefined, page: number, size: number, now: number) {
  const hasFuture = (eventId: string) => db.eventOccurrences.rows.some((o) => o.eventId === eventId && o.status === "SCHEDULED" && o.startAt > now);
  const found = db.registrations.rows
    .filter((r) => r.userId === userId && (!status || r.status === status) && (!when || (when === "UPCOMING" ? hasFuture(r.eventId) : !hasFuture(r.eventId))))
    .sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const s = Math.min(Math.max(size, 1), 100);
  const p = Math.max(0, page);
  const slice = found.slice(p * s, p * s + s);
  const eventList = slice.map((r) => db.events.get(r.eventId)).filter(Boolean) as Row[];
  const byId = new Map(summaries(eventList, userId, now).map((e) => [e.id as string, e]));
  const nextById = myNext(userId, eventList, now);
  return {
    items: slice.map((r) => ({
      id: r.id,
      status: r.status,
      message: r.message ?? null,
      decisionReason: r.decisionReason ?? null,
      decidedAt: iso(r.decidedAt),
      createdAt: iso(r.createdAt),
      event: byId.get(r.eventId),
      myNextOccurrence: nextById.get(r.eventId) ?? null,
      waitlistPosition: waitlistPosition(r),
    })),
    page: p,
    size: s,
    totalElements: found.length,
    totalPages: Math.ceil(found.length / s),
  };
}
