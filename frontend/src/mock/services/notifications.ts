// Входящие уведомления и настройки (порт NotificationService). Внешних каналов в демо нет: почта и MAX — заглушки.
import { db, type Row } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { newId } from "../util/ids";
import { iso, userShort } from "./common";
import { inboxOf } from "./notify";

export const revisionOf = (userId: string) => db.notificationInboxes.find((i) => i.userId === userId)?.revision ?? 0;
const unreadCount = (userId: string) => db.notifications.rows.filter((n) => n.userId === userId && !n.readAt).length;

export function unreadCounts(userId: string) {
  const counts = new Map<string, number>();
  for (const n of db.notifications.rows) if (n.userId === userId && !n.readAt) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, unread]) => ({ type, unread }));
}

const encodeCursor = (n: Row) => btoa(unescape(encodeURIComponent(`${iso(n.createdAt)}|${n.id}`))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeCursor(cursor: string): { before: number; beforeId: string } {
  try {
    const text = decodeURIComponent(escape(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))));
    const parts = text.split("|");
    if (parts.length !== 2) throw new Error();
    const before = Date.parse(parts[0]);
    if (Number.isNaN(before)) throw new Error();
    return { before, beforeId: parts[1] };
  } catch {
    throw badRequest("Некорректный курсор уведомлений");
  }
}

const notificationResponse = (n: Row) => ({
  id: n.id,
  actorId: n.actorId ?? null,
  type: n.type,
  category: n.category,
  title: n.title,
  body: n.body,
  targetPath: n.targetPath,
  eventId: n.eventId ?? null,
  occurrenceId: n.occurrenceId ?? null,
  organizationId: n.organizationId ?? null,
  createdAt: iso(n.createdAt),
  readAt: iso(n.readAt),
  revision: n.revision,
  actor: n.actorId ? userShort(db.users.get(n.actorId)) : null,
});

export function listNotifications(userId: string, cursor: string | undefined, size: number, unreadOnly: boolean, types: string[]) {
  const revision = revisionOf(userId);
  let before = Number.POSITIVE_INFINITY;
  let beforeId = "￿";
  if (cursor) ({ before, beforeId } = decodeCursor(cursor));
  const limit = Math.min(Math.max(size, 1), 100);
  const all = types.length === 0;
  const matching = db.notifications.rows
    .filter((n) => n.userId === userId)
    .filter((n) => !unreadOnly || !n.readAt)
    .filter((n) => (all ? n.type !== "REMINDER" : types.includes(n.type)))
    .filter((n) => n.createdAt < before || (n.createdAt === before && String(n.id) < beforeId))
    .sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const items = matching.slice(0, limit);
  return {
    items: items.map(notificationResponse),
    nextCursor: matching.length > limit ? encodeCursor(items[items.length - 1]) : null,
    unreadCount: unreadCount(userId),
    revision,
  };
}

export const pollNotifications = (userId: string, knownRevision: number) => {
  const revision = revisionOf(userId);
  return { changed: revision !== knownRevision, revision, unreadCount: unreadCount(userId) };
};

export function readNotification(userId: string, id: string, now: number) {
  const inbox = inboxOf(userId);
  const n = db.notifications.get(id);
  if (!n || n.userId !== userId) throw notFound("Уведомление не найдено");
  const changed = !n.readAt;
  if (changed) {
    n.readAt = now;
    n.updatedAt = now;
    db.notifications.touch();
    inbox.revision += 1;
    db.notificationInboxes.touch();
  }
  return { changed, revision: inbox.revision, unreadCount: unreadCount(userId) };
}

export function readAllNotifications(userId: string, throughRevision: number, now: number) {
  const inbox = inboxOf(userId);
  if (throughRevision > inbox.revision) throw badRequest("Ревизия ещё не существует");
  const unread = db.notifications.rows.filter((n) => n.userId === userId && !n.readAt && n.revision <= throughRevision);
  const changed = unread.length > 0;
  if (changed) {
    for (const n of unread) Object.assign(n, { readAt: now, updatedAt: now });
    db.notifications.touch();
    inbox.revision += 1;
    db.notificationInboxes.touch();
  }
  return { changed, revision: inbox.revision, unreadCount: unreadCount(userId) };
}

// ---------- настройки ----------

const ALL_CATEGORIES = ["REMINDERS", "ACHIEVEMENTS", "REGISTRATIONS", "ORGANIZATIONS", "EVENTS", "DISCUSSIONS", "ORGANIZERS"];

export function settingsResponse(userId: string) {
  const stored = db.notificationSettings.find((s) => s.userId === userId);
  const reminders = db.userPreferences.find((p) => p.userId === userId)?.reminders ?? true;
  return {
    channels: stored?.channels ?? [],
    categories: stored?.categories ?? ALL_CATEGORIES,
    reminders,
    availableChannels: [
      { channel: "TELEGRAM", mode: "REAL", available: false, connected: false, target: null },
      { channel: "MAX", mode: "MOCK", available: true, connected: !!stored?.maxPhone, target: stored?.maxPhone ?? null },
      { channel: "EMAIL", mode: "MOCK", available: true, connected: !!stored?.email, target: stored?.email ?? null },
    ],
  };
}

function storedSettings(userId: string, now: number): Row {
  return (
    db.notificationSettings.find((s) => s.userId === userId) ??
    db.notificationSettings.insert({ id: newId(), email: null, userId, maxPhone: null, createdAt: now, updatedAt: now, channels: [], categories: [...ALL_CATEGORIES] })
  );
}

export function saveSettings(userId: string, channels: string[], categories: string[], now: number) {
  if (channels.includes("TELEGRAM")) throw conflict("Сначала подключите Telegram");
  const stored = storedSettings(userId, now);
  if (channels.includes("EMAIL") && !stored.email) throw conflict("Сначала укажите почту");
  if (channels.includes("MAX") && !stored.maxPhone) throw conflict("Сначала укажите номер MAX");
  Object.assign(stored, { channels: [...new Set(channels)], categories: [...new Set(categories)], updatedAt: now });
  db.notificationSettings.touch();
  return settingsResponse(userId);
}

function mockChannel(userId: string, channel: "EMAIL" | "MAX", target: string | null, now: number) {
  const stored = storedSettings(userId, now);
  if (channel === "EMAIL") stored.email = target;
  else stored.maxPhone = target;
  const channels = new Set<string>(stored.channels);
  if (target === null) channels.delete(channel);
  else channels.add(channel);
  Object.assign(stored, { channels: [...channels], updatedAt: now });
  db.notificationSettings.touch();
  return settingsResponse(userId);
}

export const connectEmail = (userId: string, email: string, now: number) => mockChannel(userId, "EMAIL", email.trim(), now);
export const disconnectEmail = (userId: string, now: number) => mockChannel(userId, "EMAIL", null, now);
export const disconnectMax = (userId: string, now: number) => mockChannel(userId, "MAX", null, now);

export function connectMax(userId: string, rawPhone: string, now: number) {
  let phone = rawPhone.replace(/[\s()-]/g, "");
  if (/^8\d{10}$/.test(phone)) phone = `+7${phone.slice(1)}`;
  if (!/^\+7\d{10}$/.test(phone)) throw badRequest("Неверный номер телефона");
  return mockChannel(userId, "MAX", phone, now);
}
