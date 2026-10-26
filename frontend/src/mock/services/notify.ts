// Входящие уведомления: пишутся атомарно с действием, у каждого пользователя своя возрастающая ревизия.
// Внешних каналов (Telegram, почта, MAX) в моке нет: остаётся только колокольчик.
import { db, type Row } from "../db";
import { newId } from "../util/ids";

export type Fact = {
  /** Ключ дедупликации: повтор того же факта для того же адресата ничего не создаёт. */
  key: string;
  recipients: Iterable<string>;
  actorId?: string | null;
  type: string;
  category: string;
  title: string;
  body: string;
  targetPath: string;
  eventId?: string | null;
  occurrenceId?: string | null;
  organizationId?: string | null;
  expectedStartAt?: number | null;
};

const remindersEnabled = (userId: string) => db.userPreferences.find((p) => p.userId === userId)?.reminders ?? true;

export function inboxOf(userId: string): Row {
  let inbox = db.notificationInboxes.find((i) => i.userId === userId);
  if (!inbox) {
    const now = Date.now();
    inbox = db.notificationInboxes.insert({ id: newId(), userId, revision: 0, createdAt: now, updatedAt: now });
  }
  return inbox;
}

export function publish(facts: Fact[], now = Date.now()) {
  for (const fact of facts) {
    for (const userId of [...new Set(fact.recipients)].sort()) {
      const user = db.users.get(userId);
      if (!user || !user.active || userId === fact.actorId) continue;
      if (db.notifications.rows.some((n) => n.userId === userId && n.dedupKey === fact.key)) continue;
      if (fact.category === "REMINDERS" && !remindersEnabled(userId)) continue;
      const inbox = inboxOf(userId);
      inbox.revision += 1;
      inbox.updatedAt = now;
      db.notificationInboxes.touch();
      db.notifications.insert({
        id: newId(),
        body: fact.body,
        type: fact.type,
        title: fact.title,
        readAt: null,
        userId,
        actorId: fact.actorId ?? null,
        eventId: fact.eventId ?? null,
        category: fact.category,
        dedupKey: fact.key,
        revision: inbox.revision,
        createdAt: now,
        updatedAt: now,
        targetPath: fact.targetPath,
        occurrenceId: fact.occurrenceId ?? null,
        organizationId: fact.organizationId ?? null,
        expectedStartAt: fact.expectedStartAt ?? null,
      });
    }
  }
}

/** Все администраторы: им приходят заявки организаций и жалобы. */
export const adminIds = () => db.users.rows.filter((u) => u.systemRole === "ADMIN").map((u) => u.id as string);
