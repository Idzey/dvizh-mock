// Профиль пользователя (порт UserProfileService, UserPreferencesService, UserSportService, AttendanceHistoryService,
// OrganizerTrust и AuthService): публичная страница, предпочтения, виды спорта, история посещений.
import { db, type Row } from "../db";
import { badRequest, conflict, notFound, unauthorized } from "../http";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { fileResponse, iso, sportResponse } from "./common";
import { deleteFile, formFile, storeUpload } from "./files";
import { summaries } from "./events";
import { fields, requireClean, snapshotText, submit as submitModeration } from "./moderation";
import { getPet } from "./pets";
import { resolveSport } from "./sports";

// ---------- ответы ----------

export function userResponse(user: Row) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    active: user.active,
    systemRole: user.systemRole,
    authProvider: user.authProvider,
    createdAt: iso(user.createdAt),
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
    city: user.city ?? null,
  };
}

export const meResponse = (user: Row, now: number) => ({ ...userResponse(user), pet: getPet(user.id as string, now) });

/** Публичная ссылка на пользователя — UUID или логин без учёта регистра. */
export function resolveUserRef(ref: string): string {
  const byId = db.users.get(ref);
  if (byId?.active) return byId.id as string;
  const key = ref.toLowerCase();
  const byName = db.users.find((u) => u.active && String(u.username).toLowerCase() === key);
  if (!byName) throw notFound("Пользователь не найден");
  return byName.id as string;
}

// ---------- вход ----------

const BAD_CREDENTIALS = "Неверное имя пользователя или пароль";
export const BAD_SESSION = "Сессия недействительна, войдите заново";
const DEMO_PASSWORD = "demo-password-1";

/** Пароль сидовых аккаунтов — общий демо-пароль; зарегистрированных в браузере — их собственный. */
export function checkPassword(user: Row, password: string): boolean {
  const own = db.credentials.find((c) => c.userId === user.id);
  return own ? own.password === password : password === DEMO_PASSWORD;
}

export function login(username: string, password: string): Row {
  const key = username.trim().toLowerCase();
  const user = db.users.find((u) => String(u.username).toLowerCase() === key || String(u.email).toLowerCase() === key);
  if (!user || !user.active || !checkPassword(user, password)) throw unauthorized(BAD_CREDENTIALS);
  return user;
}

export function register(body: { username: string; email: string; firstName: string; lastName: string; password: string; accountType?: string }, now: number): Row {
  const username = body.username.trim();
  const email = body.email.trim().toLowerCase();
  if (db.users.rows.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) throw conflict("Имя пользователя уже занято");
  if (db.users.rows.some((u) => String(u.email).toLowerCase() === email)) throw conflict("Пользователь с таким email уже существует");
  requireClean(fields("Логин", username, "Имя", body.firstName, "Фамилия", body.lastName));
  const user = db.users.insert({
    id: newId(), bio: null, city: null, coins: 0, email, active: true, petName: null, lastName: body.lastName.trim(), username,
    avatarUrl: null, createdAt: now, firstName: body.firstName.trim(), systemRole: body.accountType === "ORG" ? "ORG" : "USER",
    authProvider: "LOCAL", petCheeredAt: null,
  });
  db.credentials.insert({ id: newId(), userId: user.id, password: body.password, createdAt: now, updatedAt: now });
  return user;
}

export const usernameAvailable = (username: string) => !db.users.rows.some((u) => String(u.username).toLowerCase() === username.trim().toLowerCase());
export const emailAvailable = (email: string) => !db.users.rows.some((u) => String(u.email).toLowerCase() === email.trim().toLowerCase());

// ---------- виды спорта и предпочтения ----------

export function userSportsOf(userId: string) {
  return db.userSports.rows
    .filter((us) => us.userId === userId)
    .map((us) => ({ sport: db.sports.get(us.sportId), level: us.level ?? null }))
    .filter((x) => x.sport)
    .map((x) => ({ sport: sportResponse(x.sport as Row), level: x.level }))
    .sort((a, b) => cmp(a.sport.name, b.sport.name));
}

export function saveUserSports(userId: string, items: { sportId?: string; sportName?: string; level?: string }[], now: number) {
  const levelBySport = new Map<string, string | null>();
  for (const item of items) {
    const sport = resolveSport(item.sportId, item.sportName, userId, now);
    levelBySport.delete(sport.id as string);
    levelBySport.set(sport.id as string, item.level ?? null);
  }
  db.userSports.removeWhere((us) => us.userId === userId);
  for (const [sportId, level] of levelBySport) db.userSports.insert({ id: newId(), level, userId, sportId, createdAt: now, updatedAt: now });
  return userSportsOf(userId);
}

const WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

function preferencesResponse(p: Row) {
  return {
    level: p.level,
    days: [...(p.days ?? [])].sort((a: string, b: string) => WEEK.indexOf(a) - WEEK.indexOf(b)),
    daytime: p.daytime,
    radiusKm: p.radiusKm,
    helpers: { reminders: p.reminders, nearby: p.nearby, cheer: p.cheer },
    home: p.homeLat == null || p.homeLon == null ? null : { lat: p.homeLat, lon: p.homeLon },
  };
}

export function getPreferences(userId: string) {
  if (!db.users.get(userId)) throw notFound("Пользователь не найден");
  const stored = db.userPreferences.find((p) => p.userId === userId);
  if (stored) return preferencesResponse(stored);
  return {
    level: "AMATEUR",
    days: ["TUESDAY", "THURSDAY", "SATURDAY"],
    daytime: "EVENING",
    radiusKm: 5,
    helpers: { reminders: true, nearby: true, cheer: false },
    home: null,
  };
}

export function savePreferences(userId: string, r: any, now: number) {
  if (!db.users.get(userId)) throw notFound("Пользователь не найден");
  let p = db.userPreferences.find((x) => x.userId === userId);
  if (!p) p = db.userPreferences.insert({ id: newId(), userId, createdAt: now });
  Object.assign(p, {
    level: r.level, days: [...(r.days ?? [])], daytime: r.daytime, radiusKm: r.radiusKm, reminders: r.helpers?.reminders ?? true,
    nearby: r.helpers?.nearby ?? true, cheer: r.helpers?.cheer ?? false, homeLat: r.home?.lat ?? null, homeLon: r.home?.lon ?? null, updatedAt: now,
  });
  db.userPreferences.touch();
  return preferencesResponse(p);
}

// ---------- доверие и история ----------

/** Прошедшие встречи автора или организации и разные подтверждённые участники этих встреч. */
export function hostedStats(authorId: string | null, organizationId: string | null, now: number) {
  const events = new Map<string, Row>();
  let hosted = 0;
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt >= now) continue;
    const e = db.events.get(o.eventId);
    if (!e || e.status === "DELETED") continue;
    if (authorId && e.authorId !== authorId) continue;
    if (organizationId && e.organizationId !== organizationId) continue;
    hosted++;
    events.set(e.id as string, e);
  }
  const people = new Set<string>();
  for (const r of db.registrations.rows) if (r.status === "CONFIRMED" && events.has(r.eventId)) people.add(r.userId);
  return { hostedMeetings: hosted, participantsTotal: people.size };
}

const BEGINNING = Date.parse("2000-01-01T00:00:00Z");

function period(from: number | undefined, to: number | undefined, now: number) {
  if (from !== undefined && to !== undefined && from >= to) throw badRequest("Начало периода должно быть раньше конца");
  return { from: from ?? BEGINNING, to: to !== undefined && to < now ? to : now };
}

/** Занятия, на которые человек собирался и которые состоялись: разовое — запись, серия — отметка. */
function attendedOccurrences(userId: string, sportId: string | undefined, from: number, to: number): Row[] {
  const confirmed = new Set(db.registrations.rows.filter((r) => r.userId === userId && r.status === "CONFIRMED").map((r) => r.eventId as string));
  const marked = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId).map((a) => a.occurrenceId as string));
  return db.eventOccurrences.rows.filter((o) => {
    if (o.status !== "SCHEDULED" || o.startAt < from || o.startAt >= to) return false;
    const e = db.events.get(o.eventId);
    if (!e || e.status !== "PUBLISHED" || (sportId && e.sportId !== sportId)) return false;
    return e.recurring ? marked.has(o.id as string) : confirmed.has(e.id as string);
  });
}

export function history(userId: string, sportId: string | undefined, fromIn: number | undefined, toIn: number | undefined, page: number, size: number, now: number) {
  const { from, to } = period(fromIn, toIn, now);
  const all = attendedOccurrences(userId, sportId, from, to).sort((a, b) => b.startAt - a.startAt || String(a.id).localeCompare(String(b.id)));
  const s = Math.min(Math.max(size, 1), 100);
  const p = Math.max(page, 0);
  const slice = all.slice(p * s, p * s + s);
  const eventList = [...new Set(slice.map((o) => o.eventId as string))].map((id) => db.events.get(id)).filter(Boolean) as Row[];
  const byId = new Map(summaries(eventList, userId, now).map((e) => [e.id as string, e]));
  return {
    items: slice.map((o) => ({ occurrenceId: o.id, startAt: iso(o.startAt), endAt: iso(o.endAt), event: byId.get(o.eventId) })),
    page: p,
    size: s,
    totalElements: all.length,
    totalPages: Math.ceil(all.length / s),
  };
}

export function historySummary(userId: string, fromIn: number | undefined, toIn: number | undefined, now: number) {
  const { from, to } = period(fromIn, toIn, now);
  const counts = new Map<string, number>();
  for (const o of attendedOccurrences(userId, undefined, from, to)) {
    const sportId = db.events.get(o.eventId)?.sportId;
    if (sportId) counts.set(sportId, (counts.get(sportId) ?? 0) + 1);
  }
  const bySport = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([id]) => db.sports.get(id))
    .map(([id, count]) => ({ sport: sportResponse(db.sports.get(id) as Row), count }));
  return { total: [...counts.values()].reduce((s, n) => s + n, 0), bySport };
}

export const attendedTotal = (userId: string, now: number) => attendedOccurrences(userId, undefined, BEGINNING, now).length;

// ---------- профиль ----------

const userPhotos = (userId: string) =>
  db.files.rows
    .filter((f) => f.kind === "USER_PHOTO" && f.uploadedById === userId)
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));

export function publicUser(id: string, viewerId: string, now: number) {
  const user = db.users.get(id);
  if (!user || !user.active) throw notFound("Пользователь не найден");
  const starts = new Map<string, number>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt < now) continue;
    const cur = starts.get(o.eventId);
    if (cur === undefined || o.startAt < cur) starts.set(o.eventId, o.startAt);
  }
  const upcoming = db.events.rows
    .filter((e) => e.authorId === id && e.status === "PUBLISHED" && starts.has(e.id as string) && (!e.organizationId || db.organizations.get(e.organizationId)?.status === "APPROVED"))
    .sort((a, b) => (starts.get(a.id) as number) - (starts.get(b.id) as number) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 50);
  const stats = hostedStats(id, null, now);
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl ?? null,
    city: user.city ?? null,
    bio: user.bio ?? null,
    sports: userSportsOf(id),
    attendedCount: attendedTotal(id, now),
    hostedMeetings: stats.hostedMeetings,
    participantsTotal: stats.participantsTotal,
    events: summaries(upcoming, viewerId, now),
    photos: userPhotos(id).map(fileResponse),
  };
}

function submitProfile(user: Row, now: number) {
  submitModeration(
    "USER_PROFILE", user.id, null, user.id,
    snapshotText(fields("Имя", user.firstName, "Фамилия", user.lastName, "Город", user.city, "О себе", user.bio)),
    now,
  );
}

export function updateProfile(userId: string, r: { firstName: string; lastName: string; city?: string; bio?: string }, now: number) {
  const user = db.users.get(userId) as Row;
  requireClean(fields("Имя", r.firstName, "Фамилия", r.lastName, "Город", r.city, "О себе", r.bio));
  Object.assign(user, { firstName: r.firstName, lastName: r.lastName, city: r.city?.trim() || null, bio: r.bio?.trim() || null });
  db.users.touch();
  submitProfile(user, now);
  return meResponse(user, now);
}

export async function uploadAvatar(userId: string, form: FormData | null, now: number) {
  const user = db.users.get(userId) as Row;
  const old = db.files.rows.filter((f) => f.kind === "AVATAR" && f.uploadedById === userId);
  const avatar = await storeUpload("AVATAR", formFile(form), userId, null, null, null, now);
  user.avatarUrl = `/api/files/${avatar.id}`;
  db.users.touch();
  old.forEach(deleteFile);
  return meResponse(user, now);
}

export function deleteAvatar(userId: string, now: number) {
  const user = db.users.get(userId) as Row;
  user.avatarUrl = null;
  db.users.touch();
  db.files.rows.filter((f) => f.kind === "AVATAR" && f.uploadedById === userId).forEach(deleteFile);
  return meResponse(user, now);
}

export const myPhotos = (userId: string) => userPhotos(userId).map(fileResponse);

export async function addUserPhoto(userId: string, form: FormData | null, now: number) {
  if (userPhotos(userId).length >= 6) throw conflict("Можно загрузить не больше 6 фото");
  await storeUpload("USER_PHOTO", formFile(form), userId, null, null, null, now);
  return myPhotos(userId);
}

export function removeUserPhoto(userId: string, fileId: string) {
  const photo = db.files.get(fileId);
  if (!photo || photo.kind !== "USER_PHOTO" || photo.uploadedById !== userId) throw notFound("Файл не найден");
  deleteFile(photo);
  return myPhotos(userId);
}
