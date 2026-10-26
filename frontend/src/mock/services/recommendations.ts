// Персональная подборка (порт RecommendationService, RecommendationSignals, EventScorer, DiversityRanker и RecommendationMath):
// сигналы профиля и «популяции», оценка с причинами, разнообразие выдачи (MMR), «Не интересно» и «Похожие встречи».
// Формулы и тексты причин — как у бэкенда (docs/recommendations.md), поэтому вывод совпадает с настоящим.
import { db, type Row } from "../db";
import { badRequest, notFound } from "../http";
import { DAY, partsIn, ZONE } from "../util/time";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { fileUrl, orgShort, sportResponse } from "./common";
import { summaries } from "./events";
import { featured } from "./org-awards";
import { EVENT_NOT_FOUND, FAR_FUTURE } from "./occurrences";
import { isOrganizationSuspended } from "./policy";
import { plural } from "./schedule";

// ---------- параметры (application.yml: app.recommendations) ----------

const P = {
  halfLifeDays: 45, horizonDays: 30, minLeadMinutes: 30, maxCandidates: 500, defaultRadiusKm: 10, maxDistanceFactor: 3, mmrLambda: 0.75, discoveryEvery: 5,
  weights: { sport: 0.30, distance: 0.15, level: 0.12, time: 0.12, social: 0.08, organizer: 0.08, trust: 0.05, popularity: 0.04, quorum: 0.03, urgency: 0.03 },
  scoring: { reasonThreshold: 0.03, maxReasons: 3, relatedSportShare: 0.6, relatedOrganizerShare: 0.5, onlineDistanceValue: 0.6, levelGate: 0.3, minHabit: 3 },
  dismiss: { sportFactor: 0.5, similarStrength: 0.6, floor: 0.35, minSimilarity: 0.3, nearKm: 3, similarity: { sport: 0.45, organizer: 0.25, time: 0.15, place: 0.15 } },
};

const EXPLICIT_WEIGHT = 3.0, ATTENDED_WEIGHT = 1.0, HOSTED_WEIGHT = 1.0, ACTIVE_REGISTRATION_WEIGHT = 0.8, REJECTED_WEIGHT = 0.5, COMMENT_WEIGHT = 0.3, CANCELLED_WEIGHT = 0.2;
const HISTORY_DAYS = 365, ORIGIN_POINTS = 10, SIMILAR_SPORT_MIN = 0.3, DEFAULT_SIZE = 20;
const ORG_SPORT = 0.4, ORG_DISTANCE = 0.2, ORG_TRUST = 0.15, ORG_ACTIVITY = 0.15, ORG_BEGINNER = 0.1, ORG_LOYAL_VISITS = 3;
const ACTIVE = new Set(["CONFIRMED", "PENDING", "WAITLISTED"]);
const SPORT_LEVELS = ["BEGINNER", "AMATEUR", "PRO"];
const EVENT_LEVELS = ["ANY", "BEGINNER", "AMATEUR", "PRO"];
const DAYTIMES = ["MORNING", "DAY", "EVENING"];

// ---------- математика ----------

const decay = (age: number, halfLife: number) => 2 ** (-Math.max(0, age) / halfLife);
const gaussian = (distance: number, radius: number) => 2 ** -((distance / radius) ** 2);
const saturate = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k));
const shrink = (value: number, n: number, prior: number) => (n <= 0 ? 0 : (value * n) / (n + prior));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const round2n = (v: number | null | undefined) => (v === null || v === undefined ? null : round2(v));

function intersection<T>(a: Set<T>, b: Set<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const item of small) if (large.has(item)) count++;
  return count;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  const common = intersection(a, b);
  return common === 0 ? 0 : common / (a.size + b.size - common);
}

function circularDistance(a: number, b: number, period: number) {
  const diff = Math.abs(a - b) % period;
  return Math.min(diff, period - diff);
}

// ---------- география ----------

type Point = { lat: number; lon: number };

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const distanceKm = (a: Point, b: Point) => haversineKm(a.lat, a.lon, b.lat, b.lon);

const CITIES: [number, number, string][] = [
  [55.7558, 37.6173, "Europe/Moscow"], [59.9343, 30.3351, "Europe/Moscow"], [55.7887, 49.1221, "Europe/Moscow"], [56.3269, 44.0059, "Europe/Moscow"],
  [45.0355, 38.9753, "Europe/Moscow"], [43.5855, 39.7231, "Europe/Moscow"], [54.7104, 20.4522, "Europe/Kaliningrad"], [53.1959, 50.1002, "Europe/Samara"],
  [56.8389, 60.6057, "Asia/Yekaterinburg"], [58.0105, 56.2502, "Asia/Yekaterinburg"], [54.9885, 73.3242, "Asia/Omsk"], [55.0084, 82.9357, "Asia/Novosibirsk"],
  [56.0153, 92.8932, "Asia/Krasnoyarsk"], [52.287, 104.305, "Asia/Irkutsk"], [48.4802, 135.0719, "Asia/Vladivostok"], [43.1155, 131.8855, "Asia/Vladivostok"],
  [62.0355, 129.6755, "Asia/Yakutsk"],
];

/** Пояс ближайшего крупного города; дальше 800 км ото всех — fallback. */
function zoneNear(lat: number | null | undefined, lon: number | null | undefined, fallback: string): string {
  if (lat == null || lon == null) return fallback;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [clat, clon, zone] of CITIES) {
    const d = haversineKm(lat, lon, clat, clon);
    if (d < bestDistance) {
      bestDistance = d;
      best = zone;
    }
  }
  return best !== null && bestDistance < 800 ? best : fallback;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const medianPoint = (points: Point[]): Point | null => (points.length ? { lat: median(points.map((p) => p.lat)), lon: median(points.map((p) => p.lon)) } : null);

const zoneOf = (event: Row, fallback: string) => event.timeZone ?? zoneNear(event.lat, event.lon, fallback);

const daytimeOf = (hour: number) => (hour >= 5 && hour < 12 ? "MORNING" : hour >= 12 && hour < 17 ? "DAY" : "EVENING");
const habitCell = (dow: number, daytime: string) => (dow - 1) * 3 + DAYTIMES.indexOf(daytime);
const DOW_NAMES = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

// ---------- сигналы ----------

type Origin = "REQUEST" | "HOME" | "HISTORY";
type Dismissed = { sportId: string; organizerKey: string; dow: number; daytime: string; place: Point | null; weight: number };

type Profile = {
  userId: string; role: string; city: string | null; affinity: Map<string, number>; explicitSports: Set<string>; levels: Map<string, string>;
  generalLevel: string; days: Set<number> | null; daytime: string | null; habit: number[]; habitTotal: number; origin: Point | null; originSource: Origin | null;
  radiusKm: number; zone: string; coParticipants: Map<string, number>; coParticipantNames: Map<string, string>; organizerVisits: Map<string, number>;
  dismissedEvents: Set<string>; sportDismissals: Map<string, number>; dismissed: Dismissed[]; myStatus: Map<string, string>;
};

const organizerKey = (e: Row) => (e.organizationId ?? e.authorId) as string;
const displayName = (u: Row) => (u.firstName && String(u.firstName).trim() ? u.firstName : u.username);

type Filter = { lat?: number; lon?: number; radiusKm?: number; sportId?: string; from?: number; to?: number; page?: number; size?: number };

function buildProfile(userId: string, filter: Filter | null, now: number): Profile {
  if ((filter?.lat == null) !== (filter?.lon == null)) throw badRequest("Для подбора рядом укажите и широту, и долготу");
  const user = db.users.get(userId) as Row;
  const prefs = db.userPreferences.find((p) => p.userId === userId);
  const mySports = db.userSports.rows.filter((s) => s.userId === userId);
  const halfLife = DAY * P.halfLifeDays;
  const dec = (at: number | null | undefined) => (at == null ? 1 : decay(now - at, halfLife));

  const registrations = db.registrations.rows
    .filter((r) => r.userId === userId && db.events.get(r.eventId)?.status !== "DELETED" && db.events.get(r.eventId))
    .map((r) => ({ r, e: db.events.get(r.eventId) as Row }));
  const confirmedEvents = new Set(db.registrations.rows.filter((r) => r.userId === userId && r.status === "CONFIRMED").map((r) => r.eventId as string));
  const marked = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId).map((a) => a.occurrenceId as string));
  const since = now - HISTORY_DAYS * DAY;
  const attended = db.eventOccurrences.rows
    .filter((o) => {
      if (o.status !== "SCHEDULED" || o.startAt < since || o.startAt >= now) return false;
      const e = db.events.get(o.eventId);
      if (!e || e.status !== "PUBLISHED") return false;
      return e.recurring ? marked.has(o.id as string) : confirmedEvents.has(e.id as string);
    })
    .map((o) => ({ o, e: db.events.get(o.eventId) as Row }))
    .sort((a, b) => b.o.startAt - a.o.startAt);

  const raw = new Map<string, number>();
  const add = (sportId: string, w: number) => raw.set(sportId, (raw.get(sportId) ?? 0) + w);
  const levels = new Map<string, string>();
  for (const us of mySports) {
    add(us.sportId, EXPLICIT_WEIGHT);
    if (us.level) levels.set(us.sportId, us.level);
  }
  const attendedEvents = new Set<string>();
  const organizerVisits = new Map<string, number>();
  for (const { o, e } of attended) {
    attendedEvents.add(e.id as string);
    add(e.sportId, ATTENDED_WEIGHT * dec(o.startAt));
    organizerVisits.set(organizerKey(e), (organizerVisits.get(organizerKey(e)) ?? 0) + 1);
  }
  const myStatus = new Map<string, string>();
  for (const { r, e } of registrations) {
    myStatus.set(e.id as string, r.status);
    if (attendedEvents.has(e.id as string)) continue;
    const w = ACTIVE.has(r.status) ? ACTIVE_REGISTRATION_WEIGHT : r.status === "REJECTED" ? REJECTED_WEIGHT : CANCELLED_WEIGHT;
    add(e.sportId, w * dec(r.createdAt));
  }
  for (const e of db.events.rows) if (e.authorId === userId && e.status !== "DELETED") add(e.sportId, HOSTED_WEIGHT * dec(e.createdAt));
  const lastComment = new Map<string, number>();
  for (const c of db.comments.rows) if (c.authorId === userId && !c.deletedAt) lastComment.set(c.eventId, Math.max(lastComment.get(c.eventId) ?? 0, c.createdAt));
  for (const [eventId, at] of lastComment) {
    const e = db.events.get(eventId);
    if (e) add(e.sportId, COMMENT_WEIGHT * dec(at));
  }
  const max = Math.max(0, ...raw.values());
  const affinity = new Map<string, number>();
  if (max > 0) for (const [sportId, value] of raw) if (value > 0) affinity.set(sportId, value / max);

  const defaultZone = ZONE;
  const habit = new Array<number>(21).fill(0);
  for (const { o, e } of attended) {
    const zone = e.timeZone ?? zoneNear(e.lat, e.lon, defaultZone);
    const local = partsIn(o.startAt, zone);
    habit[habitCell(local.dow, daytimeOf(local.h))]++;
  }

  let origin: Point | null = null;
  let originSource: Origin | null = null;
  if (filter?.lat != null && filter.lon != null) {
    origin = { lat: filter.lat, lon: filter.lon };
    originSource = "REQUEST";
  } else if (prefs && prefs.homeLat != null && prefs.homeLon != null) {
    origin = { lat: prefs.homeLat, lon: prefs.homeLon };
    originSource = "HOME";
  } else {
    const points: Point[] = [];
    for (const { e } of attended) {
      if (points.length >= ORIGIN_POINTS) break;
      if (e.format === "OFFLINE" && e.lat != null) points.push({ lat: e.lat, lon: e.lon });
    }
    if (!points.length) {
      for (const { e } of registrations) {
        if (points.length >= ORIGIN_POINTS) break;
        if (e.format === "OFFLINE" && e.lat != null) points.push({ lat: e.lat, lon: e.lon });
      }
    }
    origin = medianPoint(points);
    originSource = origin ? "HISTORY" : null;
  }
  const radius = filter?.radiusKm ?? prefs?.radiusKm ?? P.defaultRadiusKm;
  const zone = origin ? zoneNear(origin.lat, origin.lon, defaultZone) : defaultZone;

  // с кем занимались вместе
  const coParticipants = new Map<string, number>();
  const myConfirmed = new Set(confirmedEvents);
  const pastEvents = new Set<string>();
  for (const o of db.eventOccurrences.rows) if (o.status === "SCHEDULED" && o.startAt < now) pastEvents.add(o.eventId);
  const together = new Map<string, Set<string>>();
  for (const r of db.registrations.rows) {
    if (r.status !== "CONFIRMED" || r.userId === userId || !myConfirmed.has(r.eventId)) continue;
    const e = db.events.get(r.eventId);
    if (!e || e.recurring || e.status !== "PUBLISHED" || !pastEvents.has(e.id as string)) continue;
    together.set(r.userId, (together.get(r.userId) ?? new Set()).add(r.eventId));
  }
  for (const [id, events] of together) coParticipants.set(id, events.size);
  const myOccurrences = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId).map((a) => a.occurrenceId as string));
  for (const a of db.occurrenceAttendances.rows) {
    if (a.userId === userId || !myOccurrences.has(a.occurrenceId)) continue;
    const o = db.eventOccurrences.get(a.occurrenceId);
    if (o && o.status === "SCHEDULED" && o.startAt < now) coParticipants.set(a.userId, (coParticipants.get(a.userId) ?? 0) + 1);
  }
  const coNames = new Map<string, string>();
  for (const id of coParticipants.keys()) {
    const u = db.users.get(id);
    if (u) coNames.set(id, displayName(u));
  }

  const dismissedEvents = new Set<string>();
  const sportDismissals = new Map<string, number>();
  const dismissed: Dismissed[] = [];
  for (const d of db.recommendationDismissals.rows.filter((x) => x.userId === userId)) {
    dismissedEvents.add(d.eventId);
    const weight = dec(d.updatedAt);
    if (d.reason === "NOT_MY_SPORT") sportDismissals.set(d.sportId, (sportDismissals.get(d.sportId) ?? 0) + weight);
    const e = db.events.get(d.eventId);
    if (e) {
      const local = partsIn(e.startAt, e.timeZone ?? zoneNear(e.lat, e.lon, defaultZone));
      dismissed.push({
        sportId: e.sportId, organizerKey: organizerKey(e), dow: local.dow, daytime: daytimeOf(local.h),
        place: e.lat != null && e.lon != null ? { lat: e.lat, lon: e.lon } : null, weight,
      });
    }
  }

  const generalLevel = prefs ? prefs.level : affinity.size === 0 ? "BEGINNER" : "AMATEUR";
  return {
    userId, role: user.systemRole, city: user.city ?? null, affinity, explicitSports: new Set(mySports.map((s) => s.sportId as string)), levels, generalLevel,
    days: prefs && prefs.days?.length ? new Set(prefs.days.map((d: string) => DOW_NAMES.indexOf(d) + 1)) : null, daytime: prefs?.daytime ?? null, habit,
    habitTotal: attended.length, origin, originSource, radiusKm: radius, zone, coParticipants, coParticipantNames: coNames, organizerVisits,
    dismissedEvents, sportDismissals, dismissed, myStatus,
  };
}

const coldStart = (p: Profile) => p.affinity.size === 0;
const levelIn = (p: Profile, sportId: string) => p.levels.get(sportId) ?? p.generalLevel;
const affinityOf = (p: Profile, sportId: string) => p.affinity.get(sportId) ?? 0;

/** Все пользователи сразу: похожесть видов спорта и организаторов, «кто уже записан». */
class Population {
  readonly sportsById: Map<string, Row>;
  readonly eventParticipants = new Map<string, Set<string>>();
  readonly hostedMeetings = new Map<string, number>();
  private readonly sportFans = new Map<string, Set<string>>();
  private readonly organizerAudience = new Map<string, Set<string>>();
  private readonly population: number;
  private readonly sportMemo = new Map<string, number>();
  private readonly organizerMemo = new Map<string, number>();

  constructor(now: number) {
    this.sportsById = new Map(db.sports.rows.map((s) => [s.id as string, s]));
    const put = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id));
    for (const r of db.registrations.rows) {
      if (r.status !== "CONFIRMED") continue;
      const e = db.events.get(r.eventId);
      if (!e || e.status === "DELETED") continue;
      put(this.sportFans, e.sportId, r.userId);
      put(this.eventParticipants, e.id as string, r.userId);
      put(this.organizerAudience, organizerKey(e), r.userId);
    }
    for (const us of db.userSports.rows) put(this.sportFans, us.sportId, us.userId);
    const everyone = new Set<string>();
    for (const fans of this.sportFans.values()) for (const id of fans) everyone.add(id);
    this.population = everyone.size;
    for (const o of db.eventOccurrences.rows) {
      if (o.status !== "SCHEDULED" || o.startAt >= now) continue;
      const e = db.events.get(o.eventId);
      if (!e || e.status === "DELETED") continue;
      this.hostedMeetings.set(organizerKey(e), (this.hostedMeetings.get(organizerKey(e)) ?? 0) + 1);
    }
  }

  private static key(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  sportSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const key = Population.key(a, b);
    const cached = this.sportMemo.get(key);
    if (cached !== undefined) return cached;
    const fansA = this.sportFans.get(a) ?? new Set<string>();
    const fansB = this.sportFans.get(b) ?? new Set<string>();
    const common = intersection(fansA, fansB);
    let value = 0;
    if (common > 0) {
      const product = fansA.size * fansB.size;
      const excess = common - product / Math.max(this.population, 1);
      value = excess <= 0 ? 0 : shrink(excess / Math.sqrt(product), common, 5);
    }
    this.sportMemo.set(key, value);
    return value;
  }

  organizerSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const key = Population.key(a, b);
    const cached = this.organizerMemo.get(key);
    if (cached !== undefined) return cached;
    const audienceA = this.organizerAudience.get(a) ?? new Set<string>();
    const audienceB = this.organizerAudience.get(b) ?? new Set<string>();
    const common = intersection(audienceA, audienceB);
    const value = common === 0 ? 0 : shrink(jaccard(audienceA, audienceB), common, 5);
    this.organizerMemo.set(key, value);
    return value;
  }

  participants(eventId: string) {
    return this.eventParticipants.get(eventId) ?? new Set<string>();
  }

  hosted(key: string) {
    return this.hostedMeetings.get(key) ?? 0;
  }
}

// ---------- оценка ----------

type Candidate = { event: Row; sport: Row | undefined; occurrence: Row | null; count: number; participants: Set<string>; organizerKey: string; organizerName: string };
type Reason = { code: string; text: string };
type Feature = { code: string; value: number; weight: number; contribution: number };
type Scored = {
  candidate: Candidate; score: number; base: number; levelGate: number; dismissPenalty: number; discoveryScore: number; newSport: boolean;
  distanceKm: number | null; features: Feature[]; reasons: Reason[];
};
type Raw = { code: string; value: number; weight: number; reason: Reason | null };

const reason = (code: string, text: string): Reason => ({ code, text });
const startOf = (c: Candidate) => (c.occurrence ? c.occurrence.startAt : c.event.startAt);
const lowerSport = (sport: Row | undefined) => (sport ? String(sport.name).toLowerCase() : "вид спорта");
const capitalize = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

function formatDistance(km: number) {
  return km < 1 ? `${Math.max(50, Math.round(km * 20) * 50)} м` : `${(Math.round(km * 10) / 10).toFixed(1).replace(".", ",")} км`;
}
const originLabel = (source: Origin | null) => (source === "REQUEST" ? "от вас" : source === "HOME" ? "от дома" : "от мест, где вы обычно занимаетесь");
const levelLabel = (level: string) => (level === "BEGINNER" ? "Новичок" : level === "AMATEUR" ? "Любитель" : "Профи");
const DAY_LABEL = ["в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
const DAYTIME_LABEL: Record<string, string> = { MORNING: "утром", DAY: "днём", EVENING: "вечером" };

function levelFit(user: string, event: string): number {
  if (event === "ANY") return 0.85;
  const diff = EVENT_LEVELS.indexOf(event) - 1 - SPORT_LEVELS.indexOf(user);
  return diff === 0 ? 1 : diff === -1 ? 0.6 : diff === 1 ? 0.4 : 0.05;
}

function urgency(hours: number) {
  if (hours < 2) return 0.3;
  if (hours < 6) return 0.3 + (0.7 * (hours - 2)) / 4;
  return hours <= 72 ? 1 : Math.exp(-(hours - 72) / 168);
}

function untilText(hours: number) {
  if (hours < 1) return "Начнётся меньше чем через час";
  if (hours < 24) {
    const h = Math.round(hours);
    return `Начнётся через ${h} ${plural(h, "час", "часа", "часов")}`;
  }
  const days = Math.round(hours / 24);
  return `Начнётся через ${days} ${plural(days, "день", "дня", "дней")}`;
}

function levelReason(user: string, event: string): Reason | null {
  if (user === "BEGINNER" && event === "BEGINNER") return reason("BEGINNER_FRIENDLY", "Подходит новичкам");
  if (event !== "ANY" && event === user) return reason("LEVEL_FIT", `Уровень «${levelLabel(user)}» — как у вас`);
  return null;
}

function weighted(raws: Raw[], without: string | null) {
  let sum = 0;
  let total = 0;
  for (const raw of raws) {
    if (raw.code !== without && raw.weight > 0) {
      sum += raw.weight * raw.value;
      total += raw.weight;
    }
  }
  return total === 0 ? 0 : sum / total;
}

const FEATURE_ORDER = ["SPORT", "LEVEL", "DISTANCE", "TIME", "SOCIAL", "ORGANIZER", "TRUST", "POPULARITY", "QUORUM", "URGENCY"];

function featuresOf(raws: Raw[]): Feature[] {
  const total = raws.reduce((s, r) => s + r.weight, 0);
  const byCode = new Map<string, Feature>();
  for (const raw of raws) {
    const weight = total === 0 ? 0 : raw.weight / total;
    byCode.set(raw.code, { code: raw.code, value: raw.value, weight, contribution: weight * raw.value });
  }
  return FEATURE_ORDER.map((code) => byCode.get(code) ?? { code, value: 0, weight: 0, contribution: 0 });
}

function reasonsOf(raws: Raw[], features: Feature[], fallback: Reason): Reason[] {
  const contribution = new Map(features.map((f) => [f.code, f.contribution]));
  const ranked: { reason: Reason; contribution: number }[] = [];
  for (const raw of raws) {
    if (!raw.reason) continue;
    const c = raw.weight === 0 ? 0.04 : (contribution.get(raw.code) as number);
    if (c >= P.scoring.reasonThreshold) ranked.push({ reason: raw.reason, contribution: c });
  }
  ranked.sort((a, b) => b.contribution - a.contribution);
  const result = ranked.slice(0, P.scoring.maxReasons).map((r) => r.reason);
  return result.length ? result : [fallback];
}

function sportRaw(profile: Profile, population: Population, candidate: Candidate, weight: number): Raw {
  const sportId = candidate.event.sportId;
  const direct = affinityOf(profile, sportId);
  let related = 0;
  let relatedTo: string | null = null;
  for (const [id, value] of profile.affinity) {
    if (id === sportId) continue;
    const v = P.scoring.relatedSportShare * value * population.sportSimilarity(id, sportId);
    if (v > related) {
      related = v;
      relatedTo = id;
    }
  }
  let r: Reason | null = null;
  if (direct > 0 && direct >= related) {
    r = reason("YOUR_SPORT", `${profile.explicitSports.has(sportId) ? "Вы занимаетесь: " : "Вы часто выбираете: "}${lowerSport(candidate.sport)}`);
  } else if (related > 0) {
    r = reason("RELATED_SPORT", `Похоже на ваш интерес: ${lowerSport(population.sportsById.get(relatedTo as string))}`);
  }
  return { code: "SPORT", value: Math.max(direct, related), weight, reason: r };
}

function timeRaw(profile: Profile, candidate: Candidate): { value: number; reason: Reason | null } | null {
  if (!candidate.occurrence) return null;
  const local = partsIn(startOf(candidate), zoneOf(candidate.event, profile.zone));
  const daytime = daytimeOf(local.h);
  let pref: number | null = null;
  if (profile.days) {
    const dayMatch = profile.days.has(local.dow) ? 1 : 0;
    const daytimeMatch = profile.daytime == null ? 0.5 : daytime === profile.daytime ? 1 : Math.abs(DAYTIMES.indexOf(daytime) - DAYTIMES.indexOf(profile.daytime)) === 1 ? 0.5 : 0;
    pref = 0.6 * dayMatch + 0.4 * daytimeMatch;
  }
  let habit: number | null = null;
  if (profile.habitTotal >= P.scoring.minHabit) {
    const maxCell = Math.max(0, ...profile.habit);
    habit = (profile.habit[habitCell(local.dow, daytime)] + 1) / (maxCell + 1);
  }
  if (pref === null && habit === null) return null;
  const value = pref !== null && habit !== null ? 0.5 * pref + 0.5 * habit : (pref ?? (habit as number));
  let r: Reason | null = null;
  if (value >= 0.7) {
    const when = capitalize(`${DAY_LABEL[local.dow - 1]} ${DAYTIME_LABEL[daytime]}`);
    r = reason("GOOD_TIME", habit !== null && (pref === null || habit > pref) ? `${when} — в это время вы обычно занимаетесь` : `${when} — удобное вам время`);
  }
  return { value, reason: r };
}

function socialRaw(profile: Profile, candidate: Candidate, weight: number): Raw {
  let together = 0;
  let best: string | null = null;
  let bestCount = 0;
  let friends = 0;
  for (const id of candidate.participants) {
    const count = profile.coParticipants.get(id) ?? 0;
    if (count > 0) {
      together += count;
      friends++;
      if (count > bestCount) {
        bestCount = count;
        best = id;
      }
    }
  }
  let r: Reason | null = null;
  if (best) {
    const name = profile.coParticipantNames.get(best) ?? "знакомый";
    r = reason("FRIENDS_GOING", friends === 1 ? `Идёт ${name} — вы уже занимались вместе` : `Идут ${name} и ещё ${friends - 1}, с кем вы уже занимались`);
  }
  return { code: "SOCIAL", value: saturate(together, 2), weight, reason: r };
}

function organizerRaw(profile: Profile, population: Population, candidate: Candidate, weight: number): Raw {
  const key = candidate.organizerKey;
  const direct = saturate(profile.organizerVisits.get(key) ?? 0, 2);
  let related = 0;
  for (const [id, visits] of profile.organizerVisits) {
    if (id === key) continue;
    related = Math.max(related, P.scoring.relatedOrganizerShare * saturate(visits, 2) * population.organizerSimilarity(id, key));
  }
  let r: Reason | null = null;
  if (direct > 0 && direct >= related) r = reason("KNOWN_ORGANIZER", `Вы уже были у организатора: ${candidate.organizerName}`);
  else if (related > 0) r = reason("KNOWN_ORGANIZER", "Сюда ходят те же люди, что и на ваши встречи");
  return { code: "ORGANIZER", value: Math.max(direct, related), weight, reason: r };
}

function dismissSimilarity(sample: Dismissed, population: Population, candidate: Candidate, fallbackZone: string): number {
  const w = P.dismiss.similarity;
  const event = candidate.event;
  const sport = sample.sportId === event.sportId ? 1 : population.sportSimilarity(sample.sportId, event.sportId);
  const organizer = sample.organizerKey === candidate.organizerKey ? 1 : 0;
  const local = partsIn(startOf(candidate), zoneOf(event, fallbackZone));
  const time = local.dow === sample.dow && daytimeOf(local.h) === sample.daytime ? 1 : 0;
  let place = 0;
  if (sample.place && event.lat != null && event.lon != null) place = distanceKm(sample.place, { lat: event.lat, lon: event.lon }) <= P.dismiss.nearKm ? 1 : 0;
  const total = w.sport + w.organizer + w.time + w.place;
  return total === 0 ? 0 : (w.sport * sport + w.organizer * organizer + w.time * time + w.place * place) / total;
}

function dismissPenalty(profile: Profile, population: Population, candidate: Candidate): number {
  let penalty = P.dismiss.sportFactor ** (profile.sportDismissals.get(candidate.event.sportId) ?? 0);
  for (const sample of profile.dismissed) {
    const sim = dismissSimilarity(sample, population, candidate, profile.zone);
    if (sim >= P.dismiss.minSimilarity) penalty *= 1 - clamp01(P.dismiss.similarStrength * sim * sample.weight);
  }
  return Math.max(P.dismiss.floor, penalty);
}

function score(profile: Profile, population: Population, candidate: Candidate, now: number): Scored {
  const w = P.weights;
  const event = candidate.event;
  const sportId = event.sportId;
  const raws: Raw[] = [];

  if (!coldStart(profile)) raws.push(sportRaw(profile, population, candidate, w.sport));

  const userLevel = levelIn(profile, sportId);
  const levelValue = levelFit(userLevel, event.level);
  raws.push({ code: "LEVEL", value: levelValue, weight: w.level, reason: levelReason(userLevel, event.level) });
  const levelGate = levelValue < 0.1 ? P.scoring.levelGate : 1;

  let distance: number | null = null;
  if (profile.origin) {
    if (event.format === "ONLINE") {
      raws.push({ code: "DISTANCE", value: P.scoring.onlineDistanceValue, weight: w.distance, reason: reason("ONLINE", "Онлайн — можно присоединиться из дома") });
    } else if (event.lat != null && event.lon != null) {
      distance = distanceKm(profile.origin, { lat: event.lat, lon: event.lon });
      raws.push({
        code: "DISTANCE", value: gaussian(distance, profile.radiusKm), weight: w.distance,
        reason: distance <= profile.radiusKm ? reason("NEARBY", `${formatDistance(distance)} ${originLabel(profile.originSource)}`) : null,
      });
    }
  } else if (event.format === "ONLINE") {
    raws.push({ code: "DISTANCE", value: 0, weight: 0, reason: reason("ONLINE", "Онлайн — можно присоединиться из дома") });
  }

  const time = timeRaw(profile, candidate);
  if (time) raws.push({ code: "TIME", value: time.value, weight: w.time, reason: time.reason });

  if (profile.coParticipants.size) raws.push(socialRaw(profile, candidate, w.social));
  if (profile.organizerVisits.size) raws.push(organizerRaw(profile, population, candidate, w.organizer));

  const hosted = population.hosted(candidate.organizerKey);
  const trust = clamp01(hosted / (hosted + 5) + (event.organizationId ? 0.1 : 0));
  raws.push({ code: "TRUST", value: trust, weight: w.trust, reason: hosted >= 5 ? reason("TRUSTED_ORGANIZER", `Организатор провёл ${hosted} ${plural(hosted, "встречу", "встречи", "встреч")}`) : null });

  const count = candidate.count;
  raws.push({
    code: "POPULARITY", value: saturate(count, 6), weight: w.popularity,
    reason: count >= 5 ? reason("POPULAR", `${event.recurring ? "Уже отметились " : "Уже записались "}${count} ${plural(count, "человек", "человека", "человек")}`) : null,
  });

  const need = event.minParticipants != null ? event.minParticipants - count : 0;
  raws.push({
    code: "QUORUM", value: need >= 1 && need <= 3 ? 1 : 0, weight: w.quorum,
    reason: need >= 1 && need <= 3 ? reason("NEEDS_PEOPLE", `Не хватает ${need} ${plural(need, "человека", "человек", "человек")} — встреча состоится с вами`) : null,
  });

  const hours = Math.trunc((startOf(candidate) - now) / 60_000) / 60;
  const soon = reason("SOON", untilText(hours));
  raws.push({ code: "URGENCY", value: urgency(hours), weight: w.urgency, reason: hours <= 48 ? soon : null });

  const base = weighted(raws, null);
  const penalty = dismissPenalty(profile, population, candidate);
  const discovery = weighted(raws, "SPORT") * levelGate * penalty;
  const features = featuresOf(raws);
  return {
    candidate, score: base * levelGate * penalty, base, levelGate, dismissPenalty: penalty, discoveryScore: discovery,
    newSport: !coldStart(profile) && affinityOf(profile, sportId) === 0, distanceKm: distance, features, reasons: reasonsOf(raws, features, soon),
  };
}

// ---------- разнообразие выдачи ----------

type Ranked = { scored: Scored; discovery: boolean };

const byScore = (a: Scored, b: Scored) =>
  b.score - a.score || startOf(a.candidate) - startOf(b.candidate) || String(a.candidate.event.id).localeCompare(String(b.candidate.event.id));

function feedSimilarity(zone: string) {
  return (a: Scored, b: Scored) => {
    const ca = a.candidate;
    const cb = b.candidate;
    let value = 0;
    if (ca.event.sportId === cb.event.sportId) value += 0.6;
    if (ca.organizerKey === cb.organizerKey) value += 0.3;
    const pa = partsIn(startOf(ca), zone);
    const pb = partsIn(startOf(cb), zone);
    if (pa.y === pb.y && pa.m === pb.m && pa.d === pb.d) value += 0.1;
    if (String(ca.event.title).trim().toLowerCase() === String(cb.event.title).trim().toLowerCase()) value += 0.4;
    return Math.min(1, value);
  };
}

function rank(eligible: Scored[], needed: number, lambda: number, discoveryEvery: number, similarity: (a: Scored, b: Scored) => number): Ranked[] {
  const remaining = [...eligible].sort(byScore);
  const maxSimilarity = new Array<number>(remaining.length).fill(0);
  const taken = new Array<boolean>(remaining.length).fill(false);
  const result: Ranked[] = [];
  const limit = Math.min(needed, remaining.length);
  while (result.length < limit) {
    const position = result.length + 1;
    let pick = -1;
    let discovery = false;
    if (discoveryEvery > 0 && position % discoveryEvery === 0) {
      let best = 0;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        if (!taken[i] && s.newSport && s.discoveryScore > best) {
          best = s.discoveryScore;
          pick = i;
        }
      }
      discovery = pick >= 0;
    }
    if (pick < 0) {
      let best = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < remaining.length; i++) {
        if (taken[i]) continue;
        const value = lambda * remaining[i].score - (1 - lambda) * maxSimilarity[i];
        if (value > best) {
          best = value;
          pick = i;
        }
      }
    }
    taken[pick] = true;
    const chosen = remaining[pick];
    result.push({ scored: chosen, discovery });
    for (let i = 0; i < remaining.length; i++) if (!taken[i]) maxSimilarity[i] = Math.max(maxSimilarity[i], similarity(remaining[i], chosen));
  }
  return result;
}

// ---------- кандидаты ----------

function organizerNames(keys: Set<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const key of keys) {
    const org = db.organizations.get(key);
    if (org) names.set(key, org.name);
    else {
      const u = db.users.get(key);
      if (u) names.set(key, displayName(u));
    }
  }
  return names;
}

/** Кандидаты с ближайшим занятием в [from, to] (null — занятий нет), числом участников и подписью организатора. */
function candidatesOf(list: Row[], population: Population, from: number, to: number): Candidate[] {
  if (!list.length) return [];
  const ids = new Set(list.map((e) => e.id as string));
  const nearest = new Map<string, Row>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || !ids.has(o.eventId) || o.startAt < from || o.startAt > to) continue;
    const cur = nearest.get(o.eventId);
    if (!cur || o.startAt < cur.startAt) nearest.set(o.eventId, o);
  }
  const seriesOccurrences = new Set(list.filter((e) => e.recurring).map((e) => nearest.get(e.id as string)?.id).filter(Boolean) as string[]);
  const attendees = new Map<string, number>();
  for (const a of db.occurrenceAttendances.rows) if (seriesOccurrences.has(a.occurrenceId)) attendees.set(a.occurrenceId, (attendees.get(a.occurrenceId) ?? 0) + 1);
  const names = organizerNames(new Set(list.map(organizerKey)));
  return list.map((event) => {
    const occurrence = nearest.get(event.id as string) ?? null;
    const participants = population.participants(event.id as string);
    const count = event.recurring ? (occurrence ? (attendees.get(occurrence.id) ?? 0) : 0) : participants.size;
    const key = organizerKey(event);
    return { event, sport: population.sportsById.get(event.sportId), occurrence, count, participants, organizerKey: key, organizerName: names.get(key) ?? "организатор" };
  });
}

const isFullSingle = (c: Candidate) => !c.event.recurring && c.event.capacity != null && c.count >= c.event.capacity;

type Context = { profile: Profile; coOrganized: Set<string>; now: number };

function excludedReason(ctx: Context, scored: Scored): string | null {
  const { profile } = ctx;
  const c = scored.candidate;
  const event = c.event;
  if (profile.role !== "USER") return "Подборка — для участников: аккаунт организации и администратор не записываются на мероприятия";
  if (event.status !== "PUBLISHED") return event.status === "DELETED" ? "Мероприятие удалено" : "Мероприятие снято с публикации";
  if (event.authorId === profile.userId || ctx.coOrganized.has(event.id as string)) return "Вы организатор этого мероприятия";
  const status = profile.myStatus.get(event.id as string);
  if (status && ACTIVE.has(status)) return "Вы уже записаны";
  if (status === "REJECTED") return "Организатор уже отклонил вашу заявку";
  if (profile.dismissedEvents.has(event.id as string)) return "Вы скрыли его из подборки";
  if (!c.occurrence) return "Ближайших занятий нет";
  if (isFullSingle(c)) return "Мест нет";
  if (scored.distanceKm != null && scored.distanceKm > profile.radiusKm * P.maxDistanceFactor) return `Слишком далеко: ${formatDistance(scored.distanceKm)}`;
  return null;
}

/** События ленты (общие условия) с занятием в [from, to], ближайшие первыми. */
function feedIds(filter: { sportId?: string }, from: number, to: number | null, limit: number): string[] {
  const starts = new Map<string, number>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt < from || (to !== null && o.startAt > to)) continue;
    const cur = starts.get(o.eventId);
    if (cur === undefined || o.startAt < cur) starts.set(o.eventId, o.startAt);
  }
  return db.events.rows
    .filter((e) => starts.has(e.id as string) && e.status === "PUBLISHED" && (!e.organizationId || db.organizations.get(e.organizationId)?.status === "APPROVED") && (!filter.sportId || e.sportId === filter.sportId))
    .sort((a, b) => (starts.get(a.id) as number) - (starts.get(b.id) as number) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit)
    .map((e) => e.id as string);
}

const coOrganizedOf = (userId: string) => new Set(db.eventOrganizers.rows.filter((o) => o.userId === userId).map((o) => o.eventId as string));

// ---------- публичное API ----------

function discoveryReasons(scored: Scored): Reason[] {
  const result = [reason("NEW_SPORT", `Попробуйте новое: ${lowerSport(scored.candidate.sport)}`)];
  for (const r of scored.reasons.filter((x) => x.code !== "YOUR_SPORT" && x.code !== "RELATED_SPORT").slice(0, 2)) result.push(r);
  return result;
}

export function recommendedEvents(userId: string, filter: Filter, now: number) {
  const profile = buildProfile(userId, filter, now);
  const size = filter.size ?? DEFAULT_SIZE;
  const page = filter.page ?? 0;
  const earliest = now + P.minLeadMinutes * 60_000;
  const from = filter.from != null && filter.from > earliest ? filter.from : earliest;
  const to = filter.to ?? now + P.horizonDays * DAY;
  const empty = { items: [], page, size, totalElements: 0, totalPages: 0 };
  if (profile.role !== "USER" || to < from) return empty;
  const population = new Population(now);
  const ctx: Context = { profile, coOrganized: coOrganizedOf(userId), now };
  const ids = feedIds({ sportId: filter.sportId }, from, to, P.maxCandidates);
  const eligible = candidatesOf(ids.map((id) => db.events.get(id) as Row), population, from, to)
    .map((c) => score(profile, population, c, now))
    .filter((s) => excludedReason(ctx, s) === null);
  const ranked = rank(eligible, (page + 1) * size, P.mmrLambda, coldStart(profile) ? 0 : P.discoveryEvery, feedSimilarity(profile.zone));
  const pageItems = ranked.slice(page * size);
  const byId = new Map(summaries(pageItems.map((r) => r.scored.candidate.event), userId, from, to).map((s) => [s.id as string, s]));
  return {
    items: pageItems.map((r) => ({
      event: byId.get(r.scored.candidate.event.id as string), score: round2(r.scored.score), distanceKm: round2n(r.scored.distanceKm),
      reasons: r.discovery ? discoveryReasons(r.scored) : r.scored.reasons, discovery: r.discovery,
    })),
    page, size, totalElements: eligible.length, totalPages: Math.ceil(eligible.length / size),
  };
}

export function explain(userId: string, eventId: string, filter: Filter, now: number) {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  const profile = buildProfile(userId, filter, now);
  const population = new Population(now);
  const ctx: Context = { profile, coOrganized: coOrganizedOf(userId), now };
  const from = now + P.minLeadMinutes * 60_000;
  const candidate = candidatesOf([event], population, from, FAR_FUTURE)[0];
  const scored = score(profile, population, candidate, now);
  let excluded = excludedReason(ctx, scored);
  if (excluded === null && isOrganizationSuspended(event)) excluded = "Организация мероприятия сейчас не допущена";
  if (excluded === null && startOf(candidate) > now + P.horizonDays * DAY) excluded = `Ближайшее занятие позже чем через ${P.horizonDays} дней`;
  return {
    eventId, score: round2(scored.score), baseScore: round2(scored.base), levelGate: round2(scored.levelGate), dismissPenalty: round2(scored.dismissPenalty),
    eligible: excluded === null, excludedReason: excluded, distanceKm: round2n(scored.distanceKm),
    features: scored.features.map((f) => ({ code: f.code, value: round2(f.value), weight: round2(f.weight), contribution: round2(f.contribution) })),
    reasons: scored.reasons,
  };
}

export function dismiss(userId: string, eventId: string, why: string, now: number) {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  const existing = db.recommendationDismissals.find((d) => d.userId === userId && d.eventId === eventId);
  if (existing) Object.assign(existing, { reason: why, updatedAt: now });
  else db.recommendationDismissals.insert({ id: newId(), reason: why, userId, eventId, sportId: event.sportId, createdAt: now, updatedAt: now });
  db.recommendationDismissals.touch();
}

export function undismiss(userId: string, eventId: string) {
  if (!db.events.get(eventId)) throw notFound(EVENT_NOT_FOUND);
  const existing = db.recommendationDismissals.find((d) => d.userId === userId && d.eventId === eventId);
  if (existing) db.recommendationDismissals.remove(existing.id as string);
}

function itemSimilarity(source: Candidate, candidate: Candidate, sportSimilarity: number, profile: Profile): number {
  const a = source.event;
  const b = candidate.event;
  const level = a.level === "ANY" || b.level === "ANY" ? 0.85 : [1, 0.5, 0][Math.min(2, Math.abs(EVENT_LEVELS.indexOf(a.level) - EVENT_LEVELS.indexOf(b.level)))];
  let place: number;
  if (a.format === "ONLINE" && b.format === "ONLINE") place = 1;
  else if (a.lat != null && b.lat != null && a.lon != null && b.lon != null) place = gaussian(haversineKm(a.lat, a.lon, b.lat, b.lon), 5);
  else place = 0.3;
  let time = 0.5;
  if (source.occurrence && candidate.occurrence) {
    const first = partsIn(startOf(source), zoneOf(a, profile.zone));
    const second = partsIn(startOf(candidate), zoneOf(b, profile.zone));
    const hours = circularDistance(first.h + first.mi / 60, second.h + second.mi / 60, 24);
    time = 0.6 * gaussian(hours, 3) + (first.dow === second.dow ? 0.4 : 0);
  }
  const common = intersection(source.participants, candidate.participants);
  const people = shrink(jaccard(source.participants, candidate.participants), common, 3);
  return 0.45 * sportSimilarity + 0.15 * level + 0.15 * place + 0.1 * time + 0.15 * people;
}

/** Похожие встречи (когда мест нет или заявку отклонили). */
export function similarEvents(eventId: string, userId: string, limit: number, now: number) {
  const source = db.events.get(eventId);
  if (!source) throw notFound(EVENT_NOT_FOUND);
  const size = Math.min(Math.max(limit, 1), 20);
  const profile = buildProfile(userId, null, now);
  const population = new Population(now);
  const coOrganized = coOrganizedOf(userId);
  const ids = [...new Set([...feedIds({ sportId: source.sportId }, now, null, P.maxCandidates), ...feedIds({}, now, null, P.maxCandidates)])];
  const sourceCandidate = candidatesOf([source], population, now, FAR_FUTURE)[0];
  const personal = !coldStart(profile) && profile.role === "USER";
  const scoredList: Scored[] = [];
  for (const candidate of candidatesOf(ids.map((id) => db.events.get(id) as Row), population, now, FAR_FUTURE)) {
    const event = candidate.event;
    const status = profile.myStatus.get(event.id as string);
    if (event.id === eventId || event.authorId === userId || coOrganized.has(event.id as string) || (status && status !== "CANCELLED") || isFullSingle(candidate)) continue;
    const sportSimilarity = population.sportSimilarity(source.sportId, event.sportId);
    if (sportSimilarity < SIMILAR_SPORT_MIN) continue;
    const scored = score(profile, population, candidate, now);
    const similarity = itemSimilarity(sourceCandidate, candidate, sportSimilarity, profile);
    scoredList.push({ ...scored, score: personal ? similarity * (0.7 + 0.3 * scored.score) : similarity });
  }
  const ranked = rank(scoredList, size, P.mmrLambda, 0, feedSimilarity(profile.zone));
  return summaries(ranked.map((r) => r.scored.candidate.event), userId, now);
}

// ---------- клубы для вас ----------

type OrgPart = { value: number; weight: number; reason: Reason | null };

function organizationSport(profile: Profile, population: Population, sports: Set<string>): OrgPart {
  let sum = 0;
  const mine: string[] = [];
  let related: string | null = null;
  let bestRelated = 0;
  for (const sportId of sports) {
    const direct = affinityOf(profile, sportId);
    let viaSimilar = 0;
    let similarTo: string | null = null;
    for (const [id, value] of profile.affinity) {
      const v = 0.6 * value * population.sportSimilarity(id, sportId);
      if (id !== sportId && v > viaSimilar) {
        viaSimilar = v;
        similarTo = id;
      }
    }
    sum += Math.max(direct, viaSimilar);
    if (direct > 0) mine.push(lowerSport(population.sportsById.get(sportId)));
    else if (viaSimilar > bestRelated) {
      bestRelated = viaSimilar;
      related = lowerSport(population.sportsById.get(similarTo as string));
    }
  }
  const value = sports.size === 0 ? 0 : clamp01(sum / Math.sqrt(sports.size));
  let r: Reason | null = null;
  if (mine.length) r = reason("YOUR_SPORT", `Ваши виды: ${mine.slice(0, 2).join(", ")}`);
  else if (related) r = reason("RELATED_SPORT", `Похоже на ваш интерес: ${related}`);
  return { value, weight: ORG_SPORT, reason: r };
}

export function recommendedOrganizations(userId: string, lat: number | undefined, lon: number | undefined, limit: number, now: number) {
  const profile = buildProfile(userId, { lat, lon }, now);
  const population = new Population(now);
  const horizon = now + P.horizonDays * DAY;
  const ids = feedIds({}, now, horizon, P.maxCandidates);
  const upcomingByOrg = new Map<string, Row[]>();
  for (const id of ids) {
    const e = db.events.get(id) as Row;
    if (e.organizationId) upcomingByOrg.set(e.organizationId, [...(upcomingByOrg.get(e.organizationId) ?? []), e]);
  }
  const candidates = db.organizations.rows.filter((o) => o.status === "APPROVED" && o.accountId !== userId && upcomingByOrg.has(o.id as string));
  const featuredId = featured(now)?.id ?? null;
  const ranked: { org: Row; score: number; distanceKm: number | null; reasons: Reason[]; sports: Set<string>; upcoming: number; hosted: number }[] = [];
  for (const org of candidates) {
    const upcoming = upcomingByOrg.get(org.id as string) as Row[];
    const sports = new Set<string>(db.organizationSports.rows.filter((s) => s.organizationId === org.id).sort((a, b) => a.createdAt - b.createdAt).map((s) => s.sportId as string));
    for (const e of upcoming) sports.add(e.sportId);
    const parts: OrgPart[] = [];
    if (!coldStart(profile)) parts.push(organizationSport(profile, population, sports));
    let distance: number | null = null;
    if (profile.origin) {
      const ds = upcoming.filter((e) => e.format === "OFFLINE" && e.lat != null && e.lon != null).map((e) => distanceKm(profile.origin as Point, { lat: e.lat, lon: e.lon }));
      distance = ds.length ? Math.min(...ds) : null;
      if (distance !== null) {
        parts.push({
          value: gaussian(distance, profile.radiusKm), weight: ORG_DISTANCE,
          reason: distance <= profile.radiusKm ? reason("NEARBY", `Встречи в ${formatDistance(distance)} ${originLabel(profile.originSource)}`) : null,
        });
      }
    } else if (profile.city && org.city) {
      const same = profile.city.trim().toLowerCase() === String(org.city).trim().toLowerCase();
      parts.push({ value: same ? 1 : 0, weight: ORG_DISTANCE, reason: same ? reason("SAME_CITY", "В вашем городе") : null });
    }
    const hosted = population.hosted(org.id as string);
    const awarded = org.id === featuredId;
    parts.push({
      value: clamp01(hosted / (hosted + 5) + (awarded ? 0.2 : 0)), weight: ORG_TRUST,
      reason: awarded ? reason("AWARDED", "Организация месяца") : hosted >= 5 ? reason("TRUSTED_ORGANIZER", `Провёл ${hosted} ${plural(hosted, "встречу", "встречи", "встреч")}`) : null,
    });
    const count = upcoming.length;
    const activeReason = reason("ACTIVE", `${count} ${plural(count, "встреча", "встречи", "встреч")} в ближайший месяц`);
    parts.push({ value: saturate(count, 3), weight: ORG_ACTIVITY, reason: count >= 3 ? activeReason : null });
    if (profile.generalLevel === "BEGINNER") {
      const share = upcoming.filter((e) => e.level === "ANY" || e.level === "BEGINNER").length / count;
      parts.push({ value: share, weight: ORG_BEGINNER, reason: share >= 0.5 ? reason("BEGINNER_FRIENDLY", "Много встреч для новичков") : null });
    }
    const total = parts.reduce((s, p) => s + p.weight, 0);
    let value = parts.reduce((s, p) => s + p.weight * p.value, 0) / total;
    if ((profile.organizerVisits.get(org.id as string) ?? 0) >= ORG_LOYAL_VISITS) value *= 0.5;
    const reasons = parts
      .filter((p) => p.reason && (p.weight * p.value) / total >= 0.03)
      .sort((a, b) => b.weight * b.value - a.weight * a.value)
      .slice(0, 3)
      .map((p) => p.reason as Reason);
    ranked.push({ org, score: value, distanceKm: distance, reasons: reasons.length ? reasons : [activeReason], sports, upcoming: count, hosted });
  }
  ranked.sort((a, b) => b.score - a.score || cmp(String(a.org.name), String(b.org.name)));
  return ranked.slice(0, Math.min(Math.max(limit, 1), 20)).map((r) => ({
    organization: orgShort(r.org), city: r.org.city ?? null, description: r.org.description ?? null, logoUrl: fileUrl(r.org.logoFileId),
    sports: [...r.sports].map((id) => population.sportsById.get(id)).filter(Boolean).map((s) => sportResponse(s as Row)), upcomingEvents: r.upcoming,
    hostedMeetings: r.hosted, distanceKm: round2n(r.distanceKm), score: round2(r.score), reasons: r.reasons,
  }));
}
