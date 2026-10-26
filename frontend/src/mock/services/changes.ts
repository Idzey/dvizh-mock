// Уведомления об изменениях мероприятия (порт NotificationChanges): перед правкой снимаем состояние, после команды
// сравниваем и публикуем уведомления. Хендлер зовёт watch() под блокировкой, а ядро — commitChanges() после успеха.
import { db } from "../db";
import { dateText, timeText, ZONE } from "../util/time";
import { publish, type Fact } from "./notify";
import { quorumStatus } from "./policy";

type Slot = { id: string; start: number; end: number | null; status: string; reason: string | null; confirmedAt: number | null; attendees: Map<string, number>; quorum: string | null };

type Snapshot = {
  id: string;
  authorId: string;
  title: string;
  zone: string | null;
  recurring: boolean;
  status: string;
  reason: string | null;
  content: string;
  registrations: Map<string, { status: string; reason: string | null; eligibleAt: number }>;
  organizers: Map<string, number>;
  invites: Map<string, { status: string; invitedById: string; changedAt: number }>;
  slots: Map<string, Slot>;
};

function snapshot(eventId: string): Snapshot | null {
  const event = db.events.get(eventId);
  if (!event) return null;
  const registrations = new Map<string, { status: string; reason: string | null; eligibleAt: number }>();
  for (const r of db.registrations.rows) {
    if (r.eventId === eventId) registrations.set(r.userId, { status: r.status, reason: r.decisionReason ?? null, eligibleAt: r.decidedAt ?? r.createdAt });
  }
  const organizers = new Map<string, number>([[event.authorId, event.createdAt]]);
  for (const o of db.eventOrganizers.rows) if (o.eventId === eventId) organizers.set(o.userId, o.createdAt);
  const invites = new Map<string, { status: string; invitedById: string; changedAt: number }>();
  for (const i of db.organizerInvitations.rows) if (i.eventId === eventId) invites.set(i.userId, { status: i.status, invitedById: i.invitedById, changedAt: i.updatedAt });
  const slots = new Map<string, Slot>();
  const occurrences = db.eventOccurrences.rows.filter((o) => o.eventId === eventId).sort((a, b) => a.startAt - b.startAt);
  for (const o of occurrences) {
    const attending = new Map<string, number>();
    if (event.recurring) {
      for (const a of db.occurrenceAttendances.rows) if (a.occurrenceId === o.id) attending.set(a.userId, a.createdAt);
    } else {
      for (const [uid, r] of registrations) if (r.status === "CONFIRMED") attending.set(uid, r.eligibleAt);
    }
    slots.set(o.id, {
      id: o.id, start: o.startAt, end: o.endAt ?? null, status: o.status, reason: o.cancelReason ?? null,
      confirmedAt: o.confirmedAt ?? null, attendees: attending, quorum: quorumStatus(event, o, attending.size),
    });
  }
  const rules = db.eventScheduleRules.rows
    .filter((r) => r.eventId === eventId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => [r.firstStart, r.durationMinutes, r.rrule]);
  const photos = db.files.rows
    .filter((f) => f.eventId === eventId && f.kind === "EVENT_PHOTO")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt)
    .map((f) => f.id);
  const content = JSON.stringify([
    event.title, event.description ?? null, event.sportId, event.format, event.address ?? null, event.locationNote ?? null,
    event.onlineUrl ?? null, event.lat ?? null, event.lon ?? null, event.level, event.kind ?? null, event.requirements ?? null,
    event.equipment ?? null, event.capacity ?? null, event.minParticipants ?? null, event.joinMode, event.privateDetails ?? null,
    event.timeZone ?? null, event.seriesStartDate ?? null, event.seriesEndDate ?? null,
    event.recurring ? null : event.startAt, event.recurring ? null : (event.endAt ?? null), rules, photos,
  ]);
  return {
    id: eventId, authorId: event.authorId, title: event.title, zone: event.timeZone ?? null, recurring: !!event.recurring,
    status: event.status, reason: event.moderationReason ?? null, content, registrations, organizers, invites, slots,
  };
}

const pending = new Map<string, { actorId: string | null; before: Snapshot }>();

/** Снимок до правки; повторный вызов в той же команде безопасен. */
export function watch(eventId: string, actorId: string | null) {
  if (pending.has(eventId)) return;
  const before = snapshot(eventId);
  if (before) pending.set(eventId, { actorId, before });
}

export const discardChanges = () => pending.clear();

/** Формат как у бэкенда: «27.10.2026 07:00 Asia/Krasnoyarsk». */
const when = (s: Snapshot, ms: number) => {
  const zone = s.zone ?? ZONE;
  return `${dateText(ms, zone)} ${timeText(ms, zone)} ${zone}`;
};

const audience = (s: Snapshot): Set<string> => {
  const ids = new Set(s.organizers.keys());
  for (const [uid, r] of s.registrations) if (["CONFIRMED", "PENDING", "WAITLISTED"].includes(r.status)) ids.add(uid);
  return ids;
};
const participantAudience = (s: Snapshot, slot: Slot) => new Set([...s.organizers.keys(), ...slot.attendees.keys()]);
const slotAudience = (s: Snapshot, slot: Slot) => (s.recurring ? participantAudience(s, slot) : audience(s));

function diff(before: Snapshot, after: Snapshot, actorId: string | null, now: number): Fact[] {
  const out: Fact[] = [];
  const command = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const add = (key: string, type: string, category: string, ids: Iterable<string>, slot: Slot | null, title: string, detail: string | null) => {
    let body = after.title + (slot ? ` · ${when(after, slot.start)}` : "") + (detail && detail.trim() ? `\n${detail}` : "");
    if (body.length > 3800) body = body.slice(0, 3800);
    out.push({
      key: `${key}:${type}:${slot ? slot.id : "event"}`, recipients: ids, actorId, type, category, title, body,
      targetPath: `/events/${after.id}`, eventId: after.id, occurrenceId: slot?.id ?? null,
    });
  };

  const moderated = before.status !== after.status || before.reason !== after.reason;
  const cardChanged = before.content !== after.content;
  const datesAdded = [...after.slots.keys()].some((id) => !before.slots.has(id));
  if (moderated) {
    const type = after.status === "DELETED" ? "EVENT_DELETED" : after.status === "PUBLISHED" ? "EVENT_RESTORED" : "EVENT_UNPUBLISHED";
    const title = type === "EVENT_DELETED" ? "Мероприятие удалено" : type === "EVENT_RESTORED" ? "Мероприятие снова опубликовано" : "Мероприятие снято с публикации";
    add(command, type, "EVENTS", audience(after), null, title, after.reason);
  } else if (cardChanged || datesAdded) {
    const affected = [...after.slots.values()]
      .filter((s) => {
        const old = before.slots.get(s.id);
        return !old || old.start !== s.start || old.end !== s.end || old.status !== s.status;
      })
      .map((s) => when(after, s.start) + (s.status === "CANCELLED" ? " — отменено" : ""))
      .slice(0, 20)
      .join("; ");
    add(command, "EVENT_CHANGED", "EVENTS", audience(after), null, "Мероприятие изменено", affected ? `Изменения расписания: ${affected}` : "Обновлена карточка мероприятия.");
  }

  for (const slot of after.slots.values()) {
    const old = before.slots.get(slot.id);
    if (!old) continue;
    if (!moderated && !cardChanged && !datesAdded) {
      if (old.status !== slot.status && slot.status === "CANCELLED") {
        add(command, "OCCURRENCE_CANCELLED", "EVENTS", slotAudience(after, slot), slot, "Занятие отменено", slot.reason);
      } else if (old.start !== slot.start || old.end !== slot.end) {
        add(command, "OCCURRENCE_RESCHEDULED", "EVENTS", slotAudience(after, slot), slot, "Занятие перенесено", `Было: ${when(before, old.start)}. Стало: ${when(after, slot.start)}`);
      }
    }
    if (after.status !== "PUBLISHED" || slot.status !== "SCHEDULED" || slot.start <= now) continue;
    if (!old.confirmedAt && slot.confirmedAt) {
      add(command, "OCCURRENCE_CONFIRMED", "EVENTS", participantAudience(after, slot), slot, "Организатор подтвердил: занятие состоится", null);
    } else if (old.quorum !== slot.quorum && old.quorum && slot.quorum && !slot.confirmedAt) {
      const reached = slot.quorum === "REACHED";
      add(command, reached ? "QUORUM_REACHED" : "QUORUM_LOST", "EVENTS", participantAudience(after, slot), slot,
        reached ? "Кворум набран" : "Пока не хватает участников", `Участников: ${slot.attendees.size}. Отмену определяет организатор.`);
    }
  }

  for (const [userId, registration] of after.registrations) {
    const old = before.registrations.get(userId);
    if (old && old.status === registration.status && old.reason === registration.reason) continue;
    const status = registration.status;
    const joined = !old || old.status === "CANCELLED";
    if (joined && (status === "PENDING" || status === "CONFIRMED")) {
      add(`${command}:${userId}`, "REGISTRATION_CREATED", "REGISTRATIONS", after.organizers.keys(), null, status === "PENDING" ? "Новая заявка на участие" : "Новый участник", null);
    } else if (status === "CANCELLED" && old && old.status !== "WAITLISTED") {
      add(`${command}:${userId}`, "REGISTRATION_CANCELLED", "REGISTRATIONS", after.organizers.keys(), null, "Участник отменил запись", null);
    } else if (status === "CONFIRMED" || status === "REJECTED") {
      add(command, status === "CONFIRMED" ? "REGISTRATION_APPROVED" : "REGISTRATION_REJECTED", "REGISTRATIONS", [userId], null,
        status === "REJECTED" ? "Ваша заявка отклонена или участие прекращено" : old?.status === "WAITLISTED" ? "Освободилось место — вы записаны" : "Ваша запись подтверждена",
        registration.reason);
    }
  }

  for (const id of after.organizers.keys()) {
    if (before.organizers.has(id)) continue;
    const accepted = id === actorId;
    add(`${command}:${id}`, "ORGANIZER_ADDED", "ORGANIZERS", accepted ? [after.authorId] : [id], null,
      accepted ? "Приглашение в организаторы принято" : "Вы добавлены в организаторы", null);
  }
  for (const [userId, state] of after.invites) {
    const old = before.invites.get(userId);
    if (old && old.status === state.status && old.changedAt === state.changedAt) continue;
    if (state.status === "PENDING") {
      add(`${command}:${userId}`, "ORGANIZER_INVITED", "ORGANIZERS", [userId], null, "Вас зовут в организаторы", "Примите или откажитесь в «Активности» или на странице мероприятия.");
    } else if (state.status === "DECLINED") {
      add(`${command}:${userId}`, "ORGANIZER_INVITE_DECLINED", "ORGANIZERS", [state.invitedById], null, "Приглашение в организаторы отклонено", null);
    }
  }
  for (const id of before.organizers.keys()) {
    if (!after.organizers.has(id)) {
      add(command, "ORGANIZER_REMOVED", "ORGANIZERS", id === actorId ? [after.authorId] : [id], null, "Изменился состав организаторов", null);
    }
  }
  return out;
}

/** После успешной команды: сравнить снимки и опубликовать уведомления. */
export function commitChanges(now: number) {
  const items = [...pending.entries()];
  pending.clear();
  for (const [eventId, { actorId, before }] of items) {
    const after = snapshot(eventId);
    if (after) publish(diff(before, after, actorId, now), now);
  }
}

