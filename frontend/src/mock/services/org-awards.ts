// «Организация месяца» и вехи организаций (порт OrganizationAwardService).
// Счёт за месяц = уникальные пришедшие ×3 + вернувшиеся ×5 − 30 за каждое снятое админом событие.
import { db, type Row } from "../db";
import { conflict, notFound } from "../http";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { isoDate, parseDate, partsIn, ZONE, zonedToMs } from "../util/time";
import { fileUrl, iso } from "./common";

const PARTICIPANT_POINTS = 3;
const RETURNING_POINTS = 5;
const MODERATION_PENALTY = 30;
const MIN_MEETINGS = 2;
const TOP = 5;

const DEFAULT_LENGTH = 2 * 3600 * 1000;
const endOf = (o: Row) => o.endAt ?? o.startAt + DEFAULT_LENGTH;

type Kind = "FIRST_MEETING" | "PARTICIPANTS_100" | "RETURNING_20" | "ORG_OF_MONTH";
const KINDS: Record<Kind, { title: string; description: string; goal: number }> = {
  FIRST_MEETING: { title: "Первая встреча", description: "Провела первую встречу, на которую пришли люди", goal: 1 },
  PARTICIPANTS_100: { title: "100 участников", description: "Суммарно 100 пришедших на её встречи", goal: 100 },
  RETURNING_20: { title: "Возвращаются снова", description: "20 разных людей пришли к ней повторно", goal: 20 },
  ORG_OF_MONTH: { title: "Организация месяца", description: "Победитель месяца по числу пришедших и вернувшихся участников", goal: 0 },
};
const MILESTONES: Kind[] = ["FIRST_MEETING", "PARTICIPANTS_100", "RETURNING_20"];

export const awardImageUrl = (kind: Kind) => `/media/achievement-images/${kind === "ORG_OF_MONTH" ? "org_of_month" : `org_${kind.toLowerCase()}`}.webp`;

/** Кто пришёл на занятие: разовое — подтверждённые записи, серия — отметки; автор не считается. */
function peopleOf(event: Row, occurrence: Row): string[] {
  const ids = event.recurring
    ? db.occurrenceAttendances.rows.filter((a) => a.occurrenceId === occurrence.id).map((a) => a.userId as string)
    : db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "CONFIRMED").map((r) => r.userId as string);
  return [...new Set(ids)].filter((id) => id !== event.authorId);
}

const quorumFailed = (event: Row, occurrence: Row, n: number) =>
  event.minParticipants != null && !occurrence.confirmedAt && n < event.minParticipants;

function stats(organizationId: string, now: number) {
  const started = db.eventOccurrences.rows.filter((o) => {
    const e = db.events.get(o.eventId);
    return e?.organizationId === organizationId && e.status === "PUBLISHED" && o.status === "SCHEDULED" && o.startAt <= now && endOf(o) <= now;
  });
  let meetings = 0;
  let total = 0;
  const visits = new Map<string, number>();
  for (const o of started) {
    const event = db.events.get(o.eventId) as Row;
    const people = peopleOf(event, o);
    if (!people.length || quorumFailed(event, o, people.length)) continue;
    meetings++;
    total += people.length;
    for (const p of people) visits.set(p, (visits.get(p) ?? 0) + 1);
  }
  const returning = [...visits.values()].filter((v) => v >= 2).length;
  return (kind: Kind) => (kind === "FIRST_MEETING" ? meetings : kind === "PARTICIPANTS_100" ? total : kind === "RETURNING_20" ? returning : 0);
}

/** Выдать организации вехи, цели которых достигнуты (автоматически, один раз). */
export function grantMilestones(organizationId: string, now = Date.now()) {
  const progress = stats(organizationId, now);
  for (const kind of MILESTONES) {
    if (progress(kind) >= KINDS[kind].goal && !db.organizationAwards.rows.some((a) => a.organizationId === organizationId && a.kind === kind)) {
      db.organizationAwards.insert({
        id: newId(), kind, score: 0, period: null, status: "CONFIRMED", createdAt: now, updatedAt: now,
        confirmedAt: now, confirmedById: null, organizationId,
      });
    }
  }
}

export function grantMilestonesForAll(now = Date.now()) {
  for (const org of db.organizations.rows) if (org.status === "APPROVED") grantMilestones(org.id as string, now);
}

/** Первый день прошлого месяца в поясе демо-города. */
export function previousMonth(now: number): string {
  const p = partsIn(now, ZONE);
  const month = p.m - 1 === 0 ? 12 : p.m - 1;
  const year = p.m - 1 === 0 ? p.y - 1 : p.y;
  return isoDate(year, month, 1);
}

function monthRange(period: string) {
  const { y, m } = parseDate(period);
  return { from: zonedToMs(y, m, 1, 0, 0, 0, ZONE), to: zonedToMs(y, m + 1, 1, 0, 0, 0, ZONE) };
}

export function candidates(period: string, now: number) {
  const { from, to } = monthRange(period);
  const approved = new Map(db.organizations.rows.filter((o) => o.status === "APPROVED").map((o) => [o.id as string, o]));
  const orgOccurrences = db.eventOccurrences.rows.filter((o) => {
    const e = db.events.get(o.eventId);
    return e?.organizationId && e.status === "PUBLISHED" && o.status === "SCHEDULED";
  });
  const priorByOrg = new Map<string, Set<string>>();
  for (const o of orgOccurrences.filter((x) => x.startAt < from)) {
    const event = db.events.get(o.eventId) as Row;
    const people = peopleOf(event, o);
    if (quorumFailed(event, o, people.length)) continue;
    const set = priorByOrg.get(event.organizationId) ?? new Set<string>();
    people.forEach((p) => set.add(p));
    priorByOrg.set(event.organizationId, set);
  }
  const peopleByOrg = new Map<string, Set<string>>();
  const meetingsByOrg = new Map<string, number>();
  for (const o of orgOccurrences.filter((x) => x.startAt >= from && x.startAt < to && endOf(x) <= now)) {
    const event = db.events.get(o.eventId) as Row;
    const people = peopleOf(event, o);
    if (quorumFailed(event, o, people.length)) continue;
    meetingsByOrg.set(event.organizationId, (meetingsByOrg.get(event.organizationId) ?? 0) + 1);
    const set = peopleByOrg.get(event.organizationId) ?? new Set<string>();
    people.forEach((p) => set.add(p));
    peopleByOrg.set(event.organizationId, set);
  }
  const moderatedByOrg = new Map<string, number>();
  for (const e of db.events.rows) {
    if (e.organizationId && e.moderatedAt != null && e.moderatedAt >= from && e.moderatedAt < to && ["UNPUBLISHED", "DELETED"].includes(e.status)) {
      moderatedByOrg.set(e.organizationId, (moderatedByOrg.get(e.organizationId) ?? 0) + 1);
    }
  }
  return [...meetingsByOrg.entries()]
    .filter(([id, n]) => n >= MIN_MEETINGS && approved.has(id))
    .map(([id, n]) => {
      const people = peopleByOrg.get(id) ?? new Set<string>();
      const prior = priorByOrg.get(id) ?? new Set<string>();
      const returning = [...people].filter((p) => prior.has(p)).length;
      const moderated = moderatedByOrg.get(id) ?? 0;
      return {
        organizationId: id,
        organizationName: approved.get(id)?.name as string,
        meetings: n,
        participants: people.size,
        returning,
        moderated,
        score: PARTICIPANT_POINTS * people.size + RETURNING_POINTS * returning - MODERATION_PENALTY * moderated,
      };
    })
    .sort((a, b) => b.score - a.score || cmp(a.organizationName, b.organizationName));
}

/** Предложить победителя периода; false — награда уже есть или нет подходящих кандидатов. */
export function propose(period: string, now: number): boolean {
  if (db.organizationAwards.rows.some((a) => a.kind === "ORG_OF_MONTH" && a.period === period)) return false;
  const best = candidates(period, now).find((c) => c.score > 0);
  if (!best) return false;
  db.organizationAwards.insert({
    id: newId(), kind: "ORG_OF_MONTH", score: best.score, period, status: "PROPOSED", createdAt: now, updatedAt: now,
    confirmedAt: null, confirmedById: null, organizationId: best.organizationId,
  });
  return true;
}

export const proposePreviousMonth = (now: number) => propose(previousMonth(now), now);

const awardResponse = (award: Row) => ({
  id: award.id,
  organizationId: award.organizationId,
  organizationName: db.organizations.get(award.organizationId)?.name ?? "",
  period: award.period,
  score: award.score,
  status: award.status,
  confirmedAt: iso(award.confirmedAt),
});

export function forAdmin(month: string | undefined, now: number) {
  const awardsOfMonth = db.organizationAwards.rows.filter((a) => a.kind === "ORG_OF_MONTH");
  const period =
    month ??
    awardsOfMonth.filter((a) => a.status === "PROPOSED").sort((a, b) => String(b.period).localeCompare(String(a.period)))[0]?.period ??
    previousMonth(now);
  const award = awardsOfMonth.find((a) => a.period === period);
  return { period, award: award ? awardResponse(award) : null, candidates: candidates(period, now).slice(0, TOP) };
}

export function confirmAward(awardId: string, adminId: string, now: number) {
  const award = db.organizationAwards.get(awardId);
  if (!award) throw notFound("Награда не найдена");
  if (award.status === "PROPOSED") {
    const org = db.organizations.get(award.organizationId);
    if (org?.status !== "APPROVED") throw conflict("Организация больше не допущена на платформе, награду подтвердить нельзя");
    award.status = "CONFIRMED";
    award.confirmedAt = now;
    award.confirmedById = adminId;
    award.updatedAt = now;
    db.organizationAwards.touch();
  }
  return awardResponse(award);
}

/** Организация месяца для ленты: подтверждённая награда за прошлый или текущий месяц; null — нет. */
export function featured(now: number) {
  const min = previousMonth(now);
  const award = db.organizationAwards.rows
    .filter((a) => a.kind === "ORG_OF_MONTH" && a.status === "CONFIRMED" && String(a.period) >= min)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  const org = award && db.organizations.get(award.organizationId);
  if (!award || org?.status !== "APPROVED") return null;
  return { id: org.id, name: org.name, city: org.city ?? null, logoUrl: fileUrl(org.logoFileId), period: award.period };
}

/** Все четыре вида наград организации: полученные с датой, вехи с прогрессом. */
export function badges(organizationId: string, now: number) {
  const mine = db.organizationAwards.rows.filter((a) => a.organizationId === organizationId && a.status === "CONFIRMED");
  const progress = stats(organizationId, now);
  const result: unknown[] = [];
  for (const kind of MILESTONES) {
    const earned = mine.find((a) => a.kind === kind);
    const k = KINDS[kind];
    result.push({
      kind, title: k.title, description: k.description, earned: !!earned, earnedAt: iso(earned?.confirmedAt), period: null,
      progress: earned ? k.goal : Math.min(k.goal, progress(kind)), goal: k.goal, imageUrl: awardImageUrl(kind),
    });
  }
  const months = mine.filter((a) => a.kind === "ORG_OF_MONTH").sort((a, b) => String(b.period).localeCompare(String(a.period)));
  const k = KINDS.ORG_OF_MONTH;
  if (!months.length) {
    result.push({ kind: "ORG_OF_MONTH", title: k.title, description: k.description, earned: false, earnedAt: null, period: null, progress: 0, goal: 0, imageUrl: awardImageUrl("ORG_OF_MONTH") });
  }
  for (const a of months) {
    result.push({ kind: "ORG_OF_MONTH", title: k.title, description: k.description, earned: true, earnedAt: iso(a.confirmedAt), period: a.period, progress: 0, goal: 0, imageUrl: awardImageUrl("ORG_OF_MONTH") });
  }
  return result;
}

