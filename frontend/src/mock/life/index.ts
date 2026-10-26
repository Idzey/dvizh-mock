// «Живой мир»: награды за закончившиеся встречи, личные напоминания и ответы других участников на действия посетителя.
// Заявки принимают организаторы-«не главные» аккаунты, на новую встречу по заявке приходят заявки и вопрос,
// на вопрос в чужой встрече отвечает организатор, а заявку нового клуба через минуту одобряет администратор.
import { db, type Row } from "../db";
import { processDueRewards } from "../services/economy";
import { createComment } from "../services/comments";
import { commitChanges, discardChanges } from "../services/changes";
import { processDueReminders } from "../services/leave-tip";
import { adminApprove } from "../services/organizations";
import { approveRegistration, createRegistration } from "../services/registrations";
import { MAIN_ACCOUNTS, withoutScheduling } from "./jobs";

const REPLIES = [
  "Да, конечно, приходите! Подробности в описании.",
  "Здравствуйте! Всё в силе, будем рады вас видеть.",
  "Подойдёт, темп подстроим под группу. До встречи!",
  "Спасибо за вопрос: берите воду и удобную обувь, остальное есть.",
];
const QUESTIONS = ["Подойдёт для новичка?", "Нужно ли что-то брать с собой?", "Можно прийти с другом?"];
const GREETINGS = ["Хочу присоединиться!", "Давно искал такую компанию", "Запишите меня, пожалуйста"];

const pick = <T,>(list: T[], seed: string): T => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
};

/** Реакции на самих участников: их выполняет «живой мир» от имени случайных людей из снапшота. */
const bystanders = () => db.users.rows.filter((u) => u.systemRole === "USER" && u.active && !MAIN_ACCOUNTS.has(u.username));

function handle(job: Row, now: number) {
  const p = job.payload as Record<string, string>;
  switch (job.type) {
    case "approve-registration": {
      const reg = db.registrations.get(p.registrationId);
      const event = reg && db.events.get(reg.eventId);
      if (reg?.status === "PENDING" && event) approveRegistration(reg.id as string, event.authorId, now);
      break;
    }
    case "event-applicants": {
      const event = db.events.get(p.eventId);
      if (!event || event.status !== "PUBLISHED") break;
      const taken = new Set(db.registrations.rows.filter((r) => r.eventId === event.id).map((r) => r.userId as string));
      const people = bystanders().filter((u) => !taken.has(u.id as string) && u.id !== event.authorId);
      const first = pick(people, `${event.id}1`);
      const second = pick(people.filter((u) => u.id !== first.id), `${event.id}2`);
      for (const u of [first, second]) {
        try {
          createRegistration(event.id as string, u.id as string, pick(GREETINGS, `${event.id}${u.id}`), now);
          commitChanges(now);
        } catch {
          discardChanges();
        }
      }
      createComment(event.id as string, first.id as string, pick(QUESTIONS, `${event.id}q`), null, now);
      break;
    }
    case "reply-comment": {
      const comment = db.comments.get(p.commentId);
      const event = comment && db.events.get(comment.eventId);
      if (comment && event && !comment.deletedAt) createComment(event.id as string, event.authorId, pick(REPLIES, comment.id), comment.id, now);
      break;
    }
    case "approve-organization": {
      const org = db.organizations.get(p.organizationId);
      const admin = db.users.rows.find((u) => u.systemRole === "ADMIN");
      if (org?.status === "PENDING" && admin) adminApprove(org.id as string, admin.id as string, now);
      break;
    }
  }
  commitChanges(now);
}

let lastLife = 0;

function processLife(now: number) {
  if (now - lastLife < 1000) return;
  lastLife = now;
  const due = db.jobs.rows.filter((j) => j.runAt <= now);
  for (const job of due) {
    db.jobs.remove(job.id as string);
    try {
      withoutScheduling(() => handle(job, now));
    } catch (error) {
      discardChanges();
      console.warn("[mock] реакция мира не удалась", job.type, error);
    }
  }
}

export function runJobs(now: number): void {
  processDueRewards(now);
  processDueReminders(now);
  processLife(now);
}

