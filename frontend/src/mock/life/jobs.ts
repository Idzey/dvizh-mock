// Очередь отложенных реакций «живого мира». Лежит в таблице jobs, поэтому переживает перезагрузку страницы.
// Здесь нет зависимостей от сервисов: их хуки вызывают schedule(), а исполняет задачи life/index.ts.
import { db } from "../db";
import { newId } from "../util/ids";

/** Главные демо-аккаунты: их роли жюри и посетитель проигрывают сами, поэтому за них мир не отвечает. */
export const MAIN_ACCOUNTS = new Set(["admin", "anna", "petr", "olga", "dmitry", "elena", "sergey", "nikolai", "vika", "ladya", "enisey", "yoga", "bobry"]);

export type JobType = "approve-registration" | "event-applicants" | "reply-comment" | "approve-organization";

let suppressed = false;

/** Пока мир сам что-то делает, его действия новых реакций не порождают. */
export function withoutScheduling<T>(fn: () => T): T {
  suppressed = true;
  try {
    return fn();
  } finally {
    suppressed = false;
  }
}

export function schedule(type: JobType, delayMs: number, payload: Record<string, unknown>) {
  if (suppressed) return;
  const now = Date.now();
  // небольшой разброс, чтобы реакции не приходили строго по расписанию
  const runAt = now + delayMs + Math.round(Math.random() * delayMs * 0.5);
  db.jobs.insert({ id: newId(), type, runAt, payload, createdAt: now, updatedAt: now });
}

export const isMainAccount = (userId: string) => MAIN_ACCOUNTS.has(db.users.get(userId)?.username);
