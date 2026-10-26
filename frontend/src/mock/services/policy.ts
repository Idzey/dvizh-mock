// Порт EventAccessPolicy: единственное место правил «можно ли записаться, отменить, управлять, видеть приватное».
// Методы *BlockedReason возвращают текст для человека или null, если действие разрешено.
import { db, type Row } from "../db";

export const ORGANIZATION_SUSPENDED = "Организация не допущена администратором: управлять её мероприятиями нельзя";

export type QuorumStatus = "GATHERING" | "REACHED" | "CONFIRMED";

export const registrationOf = (eventId: string, userId: string): Row | undefined =>
  db.registrations.find((r) => r.eventId === eventId && r.userId === userId);

export const isAuthor = (event: Row, userId: string) => event.authorId === userId;

export const isOrganizer = (event: Row, userId: string) =>
  isAuthor(event, userId) || db.eventOrganizers.rows.some((o) => o.eventId === event.id && o.userId === userId);

export function isOrganizationSuspended(event: Row): boolean {
  if (!event.organizationId) return false;
  const org = db.organizations.get(event.organizationId);
  return !org || org.status !== "APPROVED";
}

export const manageConflictReason = (event: Row, deletedMessage: string) =>
  event.status === "DELETED" ? deletedMessage : ORGANIZATION_SUSPENDED;

export const canManageOrganizers = (event: Row, userId: string) =>
  isAuthor(event, userId) && event.status !== "DELETED" && !isOrganizationSuspended(event);

export function addOrganizerBlockedReason(event: Row, user: Row, registration: Row | undefined): string | null {
  if (isOrganizer(event, user.id as string)) return "Пользователь уже организатор этого мероприятия";
  if (user.systemRole === "ADMIN") return "Администратора нельзя сделать организатором";
  if (registration && ["CONFIRMED", "PENDING", "WAITLISTED"].includes(registration.status)) {
    return "Пользователь записан участником: пусть сначала отменит запись";
  }
  return null;
}

export const canManage = (event: Row, userId: string) =>
  isOrganizer(event, userId) && event.status !== "DELETED" && !isOrganizationSuspended(event);

export const canSeePrivateDetails = (event: Row, userId: string, myRegistration: Row | undefined) =>
  isOrganizer(event, userId) || myRegistration?.status === "CONFIRMED";

export function createBlockedReason(user: Row, organization: Row | undefined): string | null {
  switch (user.systemRole) {
    case "ADMIN":
      return "Администратор не создаёт мероприятия";
    case "ORG":
      return !organization || organization.status !== "APPROVED"
        ? "Публиковать мероприятия от организации можно только после одобрения заявки"
        : null;
    default:
      return null;
  }
}

/** Ближайшее запланированное занятие после `after` (по возрастанию начала). */
export function firstScheduledAfter(eventId: string, after: number): Row | undefined {
  let best: Row | undefined;
  for (const o of db.eventOccurrences.rows) {
    if (o.eventId !== eventId || o.status !== "SCHEDULED" || o.startAt <= after) continue;
    if (!best || o.startAt < best.startAt) best = o;
  }
  return best;
}

/** До какого момента открыта запись: у разового — его начало, у серии — начало ближайшего будущего занятия. */
export function upcomingStart(event: Row, now: number): number | null {
  if (!event.recurring) return event.startAt;
  return firstScheduledAfter(event.id as string, now)?.startAt ?? null;
}

export const isSingleCancelled = (event: Row) =>
  !event.recurring && db.eventOccurrences.rows.some((o) => o.eventId === event.id && o.status === "CANCELLED");

export const isFull = (event: Row, confirmedCount: number) =>
  !event.recurring && event.capacity != null && confirmedCount >= event.capacity;

export function registerBlockedReason(
  event: Row,
  role: string,
  userId: string,
  myRegistration: Row | undefined,
  confirmedCount: number,
  now: number,
): string | null {
  if (event.status === "UNPUBLISHED") return "Запись закрыта: мероприятие снято с публикации";
  if (event.status === "DELETED") return "Запись закрыта: мероприятие удалено";
  if (isSingleCancelled(event)) return "Запись закрыта: организатор отменил мероприятие";
  if (isOrganizationSuspended(event)) return "Запись закрыта: организация не допущена к публикации";
  if (role === "ADMIN") return "Администратор не записывается на мероприятия";
  if (role === "ORG") return "Аккаунт организации не записывается участником";
  if (isOrganizer(event, userId)) return "Организатор не может записаться на своё мероприятие";
  const start = upcomingStart(event, now);
  if (start === null || start <= now) {
    return event.recurring ? "Все занятия серии уже прошли, запись закрыта" : "Мероприятие уже началось, запись закрыта";
  }
  switch (myRegistration?.status) {
    case "CONFIRMED":
      return "Вы уже записаны на это мероприятие";
    case "PENDING":
      return "Заявка уже отправлена и ждёт решения организатора";
    case "REJECTED":
      return "Организатор отклонил вашу заявку. Если это ошибка, свяжитесь с организатором";
    case "WAITLISTED":
      return "Вы в листе ожидания: запишем автоматически, когда освободится место";
    default:
  }
  if (isFull(event, confirmedCount) && event.joinMode !== "FREE") return "Мест нет";
  return null;
}

/** Какой статус получит запись: FREE — сразу участник или лист ожидания, REQUEST — заявка на решение. */
export function joinAs(event: Row, confirmedCount: number): "CONFIRMED" | "PENDING" | "WAITLISTED" {
  if (event.joinMode !== "FREE") return "PENDING";
  return isFull(event, confirmedCount) ? "WAITLISTED" : "CONFIRMED";
}

export function cancelBlockedReason(event: Row, myRegistration: Row | undefined, now: number): string | null {
  if (!myRegistration || myRegistration.status === "CANCELLED") return "Вы не записаны на это мероприятие";
  if (myRegistration.status === "REJECTED") return "Заявка отклонена организатором, отменять нечего";
  const start = upcomingStart(event, now);
  if (start === null || start <= now) {
    return event.recurring ? "Все занятия серии уже прошли, выходить не из чего" : "Мероприятие уже началось, отменить запись нельзя";
  }
  return null;
}

export function approveBlockedReason(event: Row, registration: Row, confirmedCount: number, now: number): string | null {
  if (registration.status === "CANCELLED") return "Участник сам отменил запись";
  if (event.status !== "PUBLISHED") return "Мероприятие снято с публикации, подтверждать заявки нельзя";
  if (isSingleCancelled(event)) return "Мероприятие отменено организатором, подтверждать заявки нельзя";
  const start = upcomingStart(event, now);
  if (start === null || start <= now) {
    return event.recurring
      ? "Все занятия серии уже прошли, подтверждать заявки нельзя"
      : "Мероприятие уже началось, подтверждать заявки нельзя";
  }
  if (isFull(event, confirmedCount)) return "Мест нет";
  return null;
}

export const rejectBlockedReason = (registration: Row) =>
  registration.status === "CANCELLED" ? "Участник сам отменил запись" : null;

export const commentBlockedReason = (event: Row) => (event.status === "DELETED" ? "Мероприятие удалено, обсуждение закрыто" : null);

export function replyBlockedReason(event: Row, parent: Row): string | null {
  const blocked = commentBlockedReason(event);
  if (blocked) return blocked;
  if (parent.hidden) return "Нельзя ответить на сообщение, скрытое модератором";
  return parent.deletedAt ? "Нельзя ответить на удалённое сообщение" : null;
}

export function commentEditBlockedReason(event: Row, comment: Row, userId: string): string | null {
  if (comment.authorId !== userId) return "Изменить можно только своё сообщение";
  if (comment.deletedAt) return "Сообщение уже удалено";
  if (comment.hidden) return "Сообщение скрыто модератором";
  return commentBlockedReason(event);
}

/** Автор и соорганизаторы: для меток «Организатор» в обсуждении. */
export function organizerIds(event: Row): Set<string> {
  const ids = new Set<string>([event.authorId]);
  for (const o of db.eventOrganizers.rows) if (o.eventId === event.id) ids.add(o.userId);
  return ids;
}

export function restoreBlockedReason(event: Row): string | null {
  switch (event.status) {
    case "UNPUBLISHED":
      return null;
    case "DELETED":
      return "Удалённое мероприятие восстановить нельзя";
    default:
      return "Мероприятие и так опубликовано";
  }
}

export const unpublishBlockedReason = (event: Row) => (event.status === "DELETED" ? "Мероприятие удалено, снимать нечего" : null);

export function attendBlockedReason(
  event: Row,
  occurrence: Row,
  userId: string,
  myRegistration: Row | undefined,
  attending: boolean,
  attendeesCount: number,
  now: number,
): string | null {
  if (!event.recurring) return "На разовое мероприятие отмечаться не нужно: достаточно записи";
  if (event.status === "UNPUBLISHED") return "Мероприятие снято с публикации, отмечаться нельзя";
  if (event.status === "DELETED") return "Мероприятие удалено, отмечаться нельзя";
  if (isOrganizationSuspended(event)) return "Организация не допущена к публикации, отмечаться нельзя";
  if (attending) return "Вы уже отметились на это занятие";
  if (occurrence.status === "CANCELLED") return "Занятие отменено";
  if (occurrence.startAt <= now) return "Занятие уже началось";
  if (isOrganizer(event, userId)) return "Организатор не отмечается на занятия своей серии";
  if (myRegistration?.status !== "CONFIRMED") {
    return myRegistration?.status === "PENDING"
      ? "Заявка в серию ещё ждёт решения организатора"
      : "Чтобы отмечаться на занятия, сначала запишитесь в серию";
  }
  if (event.capacity != null && attendeesCount >= event.capacity) return "Мест нет";
  return null;
}

export function unattendBlockedReason(event: Row, occurrence: Row, attending: boolean, now: number): string | null {
  if (!event.recurring) return "Чтобы не прийти на разовое мероприятие, отмените запись";
  if (!attending) return "Вы не отмечены на это занятие";
  if (occurrence.status === "CANCELLED") return "Занятие отменено";
  if (occurrence.startAt <= now) return "Занятие уже началось, отметку не снять";
  return null;
}

export function manageOccurrencesBlockedReason(event: Row): string | null {
  if (!event.recurring) {
    return "Занятия меняются только у повторяющегося мероприятия; время разового правится в самом мероприятии";
  }
  if (event.status === "DELETED") return "Мероприятие удалено, менять занятия нельзя";
  return isOrganizationSuspended(event) ? ORGANIZATION_SUSPENDED : null;
}

export function changeOccurrenceBlockedReason(occurrence: Row, now: number): string | null {
  if (occurrence.status === "CANCELLED") return "Занятие уже отменено";
  if (occurrence.startAt <= now) return "Занятие уже началось, менять его нельзя";
  return null;
}

export function cancelOccurrenceBlockedReason(event: Row, occurrence: Row, now: number): string | null {
  if (event.status === "DELETED") return "Мероприятие удалено, отменять нечего";
  if (isOrganizationSuspended(event)) return ORGANIZATION_SUSPENDED;
  return changeOccurrenceBlockedReason(occurrence, now);
}

export function quorumStatus(event: Row, occurrence: Row, count: number): QuorumStatus | null {
  if (event.minParticipants == null) return null;
  if (occurrence.confirmedAt) return "CONFIRMED";
  return count >= event.minParticipants ? "REACHED" : "GATHERING";
}

export function confirmOccurrenceBlockedReason(event: Row, occurrence: Row, now: number): string | null {
  if (event.minParticipants == null) return "У мероприятия не задан кворум, подтверждать нечего";
  if (event.status === "DELETED") return "Мероприятие удалено";
  if (event.status === "UNPUBLISHED") return "Мероприятие снято с публикации";
  if (isOrganizationSuspended(event)) return ORGANIZATION_SUSPENDED;
  if (occurrence.status === "CANCELLED") return "Занятие отменено";
  if (occurrence.startAt <= now) return "Занятие уже началось";
  return null;
}

export const canCancelOccurrence = (event: Row, occurrence: Row, userId: string, now: number) =>
  isOrganizer(event, userId) && cancelOccurrenceBlockedReason(event, occurrence, now) === null;

export const canRescheduleOccurrence = (event: Row, occurrence: Row, userId: string, now: number) =>
  isOrganizer(event, userId) && manageOccurrencesBlockedReason(event) === null && changeOccurrenceBlockedReason(occurrence, now) === null;

export const canConfirmOccurrence = (event: Row, occurrence: Row, userId: string, now: number) =>
  !occurrence.confirmedAt && isOrganizer(event, userId) && confirmOccurrenceBlockedReason(event, occurrence, now) === null;
