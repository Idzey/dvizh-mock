// Монеты, уровень, достижения и награды за встречи (порт WalletService, AchievementService, RewardService).
// Награды начисляются лениво: при каждом запросе обрабатываются занятия, которые уже закончились.
import { db, type Row } from "../db";
import { conflict, forbidden, notFound } from "../http";
import { newId } from "../util/ids";
import { DAY, startOfDay, ZONE } from "../util/time";
import { iso } from "./common";
import { grantMilestones } from "./org-awards";
import { publish } from "./notify";
import { grantItem, itemLabel } from "./pet-catalog";

export const PERSONAL_ONLY = "Монеты и достижения есть только у личных аккаунтов";
export const MEETINGS_PER_LEVEL = 5;
export const ENERGY_MAX = 5;
const MEETING_KINDS = ["MEETING", "ORGANIZER_MEETING"];

export type AchievementCode = "FIRST_STEP" | "VERSATILE" | "REGULAR" | "TEAM_BUILDER" | "SOUL_OF_COMPANY" | "OWN_BEAVER";

export const ACHIEVEMENTS: Record<
  AchievementCode,
  { title: string; description: string; goal: number; unit: string; rewardCoins: number; rewardItem: string | null }
> = {
  FIRST_STEP: { title: "Первый шаг", description: "Сходить на первую встречу", goal: 1, unit: "встреч", rewardCoins: 30, rewardItem: null },
  VERSATILE: { title: "Разносторонний", description: "Попробовать 3 разных вида спорта", goal: 3, unit: "видов спорта", rewardCoins: 50, rewardItem: null },
  REGULAR: { title: "Завсегдатай", description: "Сходить на 10 встреч", goal: 10, unit: "встреч", rewardCoins: 0, rewardItem: "neck:medal" },
  TEAM_BUILDER: { title: "Собрал команду", description: "Провести встречу, на которую пришли 3 человека и больше", goal: 1, unit: "встреч", rewardCoins: 50, rewardItem: null },
  SOUL_OF_COMPANY: { title: "Душа компании", description: "Провести 5 встреч", goal: 5, unit: "встреч", rewardCoins: 0, rewardItem: "hat:crown" },
  OWN_BEAVER: { title: "Свой бобр", description: "Сходить на встречу ССК ВГУ «Хищные бобры»", goal: 1, unit: "встреч", rewardCoins: 0, rewardItem: "shirt:beavers" },
};
export const ACHIEVEMENT_CODES = Object.keys(ACHIEVEMENTS) as AchievementCode[];
export const BEAVERS_ORGANIZATION_CODE = "predatory-beavers";

export const achievementImageUrl = (code: string) => `/media/achievement-images/${code.toLowerCase()}.webp`;

export function requireUserAccount(userId: string): Row {
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  if (user.systemRole !== "USER") throw forbidden(PERSONAL_ONLY);
  return user;
}

/** Единственное место, где меняется баланс. false — такая операция уже была (refKey занят). */
export function applyCoins(
  userId: string,
  amount: number,
  kind: string,
  refKey: string,
  note: string,
  eventId: string | null,
  occurrenceId: string | null,
  occurredAt: number,
): boolean {
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  if (user.systemRole !== "USER") throw forbidden(PERSONAL_ONLY);
  if (db.coinLedger.rows.some((e) => e.refKey === refKey)) return false;
  if (user.coins + amount < 0) throw conflict(`Не хватает монет: нужно ${-amount}, у тебя ${user.coins}`);
  const now = Date.now();
  db.coinLedger.insert({ id: newId(), kind, note, amount, refKey, userId, eventId, createdAt: now, updatedAt: now, occurredAt, occurrenceId });
  user.coins += amount;
  db.users.touch();
  return true;
}

const ledgerOf = (userId: string) => db.coinLedger.rows.filter((e) => e.userId === userId);
const countKind = (userId: string, kind: string) => ledgerOf(userId).filter((e) => e.kind === kind).length;

/** Засчитанные встречи для уровня: проведённая считается за две. */
export const countedMeetings = (userId: string) => countKind(userId, "MEETING") + 2 * countKind(userId, "ORGANIZER_MEETING");

export function wallet(userId: string, now: number) {
  const user = requireUserAccount(userId);
  const counted = countedMeetings(userId);
  const energy = Math.min(
    ENERGY_MAX,
    ledgerOf(userId).filter((e) => MEETING_KINDS.includes(e.kind) && e.occurredAt >= now - 7 * DAY && e.occurredAt < now + 1000).length,
  );
  const recent = ledgerOf(userId)
    .sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt)
    .slice(0, 20);
  return {
    coins: user.coins,
    level: 1 + Math.floor(counted / MEETINGS_PER_LEVEL),
    countedMeetings: counted,
    energy,
    energyMax: ENERGY_MAX,
    entries: recent.map((e) => ({
      id: e.id,
      amount: e.amount,
      kind: e.kind,
      note: e.note,
      eventId: e.eventId ?? null,
      eventTitle: (e.eventId && db.events.get(e.eventId)?.title) || null,
      occurredAt: iso(e.occurredAt),
    })),
  };
}

function progress(userId: string, code: AchievementCode): number {
  switch (code) {
    case "FIRST_STEP":
    case "REGULAR":
      return countKind(userId, "MEETING");
    case "VERSATILE": {
      const sports = new Set<string>();
      for (const e of ledgerOf(userId)) {
        if (e.kind !== "MEETING" || !e.eventId) continue;
        const sportId = db.events.get(e.eventId)?.sportId;
        if (sportId) sports.add(sportId);
      }
      return sports.size;
    }
    case "TEAM_BUILDER":
    case "SOUL_OF_COMPANY":
      return countKind(userId, "ORGANIZER_MEETING");
    case "OWN_BEAVER": {
      const beavers = db.organizations.find((o) => o.code === BEAVERS_ORGANIZATION_CODE);
      if (!beavers) return 0;
      return ledgerOf(userId).filter((e) => e.kind === "MEETING" && e.eventId && db.events.get(e.eventId)?.organizationId === beavers.id).length;
    }
  }
}

const rewardText = (code: AchievementCode) => {
  const a = ACHIEVEMENTS[code];
  return a.rewardItem ? `Вещь: ${itemLabel(a.rewardItem)}` : `+${a.rewardCoins} монет`;
};

export function achievementsOf(userId: string) {
  requireUserAccount(userId);
  const earned = new Map(db.userAchievements.rows.filter((a) => a.userId === userId).map((a) => [a.code, a]));
  return ACHIEVEMENT_CODES.map((code) => {
    const a = ACHIEVEMENTS[code];
    const mine = earned.get(code);
    return {
      code,
      title: a.title,
      description: a.description,
      progress: mine ? a.goal : Math.min(a.goal, progress(userId, code)),
      goal: a.goal,
      unit: a.unit,
      reward: rewardText(code),
      earnedAt: iso(mine?.createdAt),
      imageUrl: achievementImageUrl(code),
    };
  });
}

export function grantAchievement(userId: string, code: AchievementCode, now = Date.now()) {
  if (db.userAchievements.rows.some((a) => a.userId === userId && a.code === code)) return;
  db.userAchievements.insert({ id: newId(), code, userId, createdAt: now, updatedAt: now });
  const a = ACHIEVEMENTS[code];
  if (a.rewardCoins > 0) {
    applyCoins(userId, a.rewardCoins, "ACHIEVEMENT", `ACHIEVEMENT:${code}:${userId}`, `Достижение «${a.title}»`, null, null, now);
  }
  if (a.rewardItem) grantItem(userId, a.rewardItem);
  publish(
    [
      {
        key: `achievement:${code}:${userId}`,
        recipients: [userId],
        type: "ACHIEVEMENT_UNLOCKED",
        category: "ACHIEVEMENTS",
        title: `Новое достижение «${a.title}»`,
        body: `${a.description}. Награда: ${rewardText(code)}`,
        targetPath: "/profile",
      },
    ],
    now,
  );
}

/** Выдать достижения, условия которых выполнены. */
export function checkAchievements(userId: string, now = Date.now()) {
  for (const code of ACHIEVEMENT_CODES) {
    if (db.userAchievements.rows.some((a) => a.userId === userId && a.code === code)) continue;
    if (progress(userId, code) >= ACHIEVEMENTS[code].goal) grantAchievement(userId, code, now);
  }
}

// --- кто пришёл на занятие ---

const DEFAULT_LENGTH = 2 * 3600 * 1000;
export const occurrenceEnd = (occurrence: Row) => occurrence.endAt ?? occurrence.startAt + DEFAULT_LENGTH;

/** Участники занятия без повторов и без автора: разовое — подтверждённые записи, серия — отметки «приду». */
export function occurrenceParticipants(event: Row, occurrence: Row): string[] {
  const ids = event.recurring
    ? db.occurrenceAttendances.rows.filter((a) => a.occurrenceId === occurrence.id).map((a) => a.userId as string)
    : db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "CONFIRMED").map((r) => r.userId as string);
  return [...new Set(ids)].filter((id) => id !== event.authorId);
}

export const quorumFailed = (event: Row, occurrence: Row, participants: number) =>
  event.minParticipants != null && !occurrence.confirmedAt && participants < event.minParticipants;

// --- награды ---

const MEETING_REWARD = 10;
const FIRST_MEETING_BONUS = 30;
const ORGANIZER_BASE = 30;
const ORGANIZER_PER_PARTICIPANT = 5;
const ORGANIZER_MAX = 80;
const FIRST_ORGANIZED_BONUS = 50;
const ORGANIZER_MIN_PARTICIPANTS = 3;
const PARTICIPANT_DAILY_LIMIT = 3;
const ORGANIZER_DAILY_LIMIT = 2;

function countInRange(userId: string, kind: string, from: number, to: number) {
  return ledgerOf(userId).filter((e) => e.kind === kind && e.occurredAt >= from && e.occurredAt < to).length;
}

function rewardParticipant(userId: string, event: Row, occurrence: Row, end: number, dayStart: number, dayEnd: number) {
  if (countInRange(userId, "MEETING", dayStart, dayEnd) >= PARTICIPANT_DAILY_LIMIT) return false;
  if (!applyCoins(userId, MEETING_REWARD, "MEETING", `MEETING:${occurrence.id}:${userId}`, "Встреча", event.id, occurrence.id, end)) return false;
  applyCoins(userId, FIRST_MEETING_BONUS, "FIRST_MEETING", `FIRST_MEETING:${userId}`, "Первая встреча на платформе", event.id, occurrence.id, end);
  return true;
}

function rewardOrganizer(event: Row, occurrence: Row, participants: string[], now: number, end: number, dayStart: number, dayEnd: number) {
  const author = event.authorId as string;
  const counted = participants.filter((id) => {
    const u = db.users.get(id);
    return u?.active && u.createdAt != null && u.createdAt < now - DAY;
  }).length;
  if (counted < ORGANIZER_MIN_PARTICIPANTS || countInRange(author, "ORGANIZER_MEETING", dayStart, dayEnd) >= ORGANIZER_DAILY_LIMIT) return false;
  const amount = Math.min(ORGANIZER_MAX, ORGANIZER_BASE + ORGANIZER_PER_PARTICIPANT * counted);
  if (!applyCoins(author, amount, "ORGANIZER_MEETING", `ORGANIZER_MEETING:${occurrence.id}`, "Проведённая встреча", event.id, occurrence.id, end)) return false;
  applyCoins(author, FIRST_ORGANIZED_BONUS, "FIRST_ORGANIZED", `FIRST_ORGANIZED:${author}`, "Первая проведённая встреча", event.id, occurrence.id, end);
  return true;
}

function processOne(occurrence: Row, now: number) {
  occurrence.rewardProcessedAt = now; // отметка ставится в любом случае: сорванное занятие не проверяем снова
  db.eventOccurrences.touch();
  const event = db.events.get(occurrence.eventId);
  if (!event || event.status !== "PUBLISHED" || occurrence.status !== "SCHEDULED") return;
  const everyone = occurrenceParticipants(event, occurrence);
  const participants = everyone.filter((id) => db.users.get(id)?.systemRole === "USER");
  if (!participants.length || quorumFailed(event, occurrence, everyone.length)) return;
  const end = occurrenceEnd(occurrence);
  const dayStart = startOfDay(end, ZONE);
  const dayEnd = dayStart + DAY;
  const touched = new Set<string>();
  for (const userId of participants) if (rewardParticipant(userId, event, occurrence, end, dayStart, dayEnd)) touched.add(userId);
  if (!event.organizationId && db.users.get(event.authorId)?.systemRole === "USER" && rewardOrganizer(event, occurrence, participants, now, end, dayStart, dayEnd)) {
    touched.add(event.authorId);
  }
  for (const userId of touched) checkAchievements(userId, now);
  if (event.organizationId) grantMilestones(event.organizationId, now);
}

let lastProcessed = 0;

/** Обработать все закончившиеся занятия. Дёшево, если ничего нового нет. */
export function processDueRewards(now: number, force = false): number {
  if (!force && now - lastProcessed < 5000) return 0;
  lastProcessed = now;
  const due = db.eventOccurrences.rows.filter((o) => !o.rewardProcessedAt && o.startAt <= now && occurrenceEnd(o) <= now).slice(0, 500);
  for (const occurrence of due) {
    try {
      processOne(occurrence, now);
    } catch (error) {
      console.warn("[mock] награда за занятие не начислена", occurrence.id, error);
    }
  }
  return due.length;
}
