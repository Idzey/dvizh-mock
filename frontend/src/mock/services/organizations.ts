// Организации (порт OrganizationService, OrganizationOverviewService, OrganizationSubscriptionService,
// OrganizationContacts и AdminOrganizationService): анкета и допуск, публичная страница, каталог, подписки.
import { db, type Row } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../http";
import { schedule } from "../life/jobs";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { isoDate, monthKey, partsIn, ZONE } from "../util/time";
import { fileFocus, fileResponse, fileUrl, iso, sportResponse, userShort } from "./common";
import { deleteFile, formFile, storeUpload } from "./files";
import { badges, featured as featuredAward } from "./org-awards";
import { fields, requireClean, resolve as resolveModeration, snapshotText, submit as submitModeration } from "./moderation";
import { adminIds, publish } from "./notify";
import { hostedStats } from "./users";
import { resolveSport } from "./sports";

export const ORG_NOT_FOUND = "Организация не найдена";
const NO_PROFILE = "Анкета организации ещё не заполнена";
const MAX_DOCUMENTS = 10;
const MAX_SPORTS = 10;
const DEFAULT_LENGTH = 2 * 3600 * 1000;
const endOf = (o: Row) => o.endAt ?? o.startAt + DEFAULT_LENGTH;

// ---------- контакты ----------

const PHONE_CHARS = /^\+?[0-9 ()-]+$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TELEGRAM = /^(@[A-Za-z0-9_]{5,32}|(https?:\/\/)?t\.me\/[A-Za-z0-9_]{5,32}\/?)$/;
const VK = /^(https?:\/\/)?(m\.)?vk\.com\/[A-Za-z0-9_.-]+\/?$/;
const MAXRE = /^(https?:\/\/)?max\.ru\/\S+$/;
const WEBSITE = /^https?:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(:\d+)?(\/\S*)?$/;

const phone = (value: string) => {
  if (!PHONE_CHARS.test(value)) return false;
  const digits = [...value].filter((c) => c >= "0" && c <= "9").length;
  return digits >= 10 && digits <= 15;
};

const CONTACT_CHECKS: Record<string, { valid: (v: string) => boolean; error: string }> = {
  PHONE: { valid: phone, error: "Неверный формат телефона: нужно 10–15 цифр, например +7 900 123-45-67" },
  WHATSAPP: { valid: phone, error: "Неверный номер WhatsApp: нужно 10–15 цифр, например +7 900 123-45-67" },
  EMAIL: { valid: (v) => EMAIL.test(v), error: "Неверный формат почты, например club@example.ru" },
  TELEGRAM: { valid: (v) => TELEGRAM.test(v), error: "Укажите Telegram как @имя или ссылку https://t.me/имя" },
  VK: { valid: (v) => VK.test(v), error: "Укажите ссылку ВКонтакте, например https://vk.com/club" },
  MAX: { valid: (v) => MAXRE.test(v) || phone(v), error: "Укажите ссылку https://max.ru/... или номер телефона для MAX" },
  WEBSITE: { valid: (v) => WEBSITE.test(v), error: "Укажите адрес сайта, начиная с http:// или https://" },
};

function normalizeContacts(contacts: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [type, raw] of Object.entries(contacts ?? {})) {
    if (!raw || !raw.trim()) continue;
    const check = CONTACT_CHECKS[type];
    if (!check) continue;
    const value = raw.trim();
    if (!check.valid(value)) throw badRequest(check.error);
    result[type] = value;
  }
  if (!Object.keys(result).length) throw badRequest("Укажите хотя бы один контакт");
  return result;
}

// ---------- ответы ----------

const documentsOf = (orgId: string) =>
  db.files.rows.filter((f) => f.kind === "ORG_DOCUMENT" && f.organizationId === orgId).sort((a, b) => a.createdAt - b.createdAt).map(fileResponse);

export function sportsOf(orgId: string) {
  return db.organizationSports.rows
    .filter((s) => s.organizationId === orgId)
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .map((s) => db.sports.get(s.sportId))
    .filter(Boolean)
    .map((s) => sportResponse(s as Row));
}

const organizationResponse = (org: Row) => ({
  id: org.id,
  name: org.name,
  description: org.description ?? null,
  city: org.city ?? null,
  contacts: org.contacts ?? {},
  status: org.status,
  rejectReason: org.rejectReason ?? null,
  submittedAt: iso(org.submittedAt),
  reviewedAt: iso(org.reviewedAt),
  createdAt: iso(org.createdAt),
  updatedAt: iso(org.updatedAt),
  logoUrl: fileUrl(org.logoFileId),
  documents: documentsOf(org.id as string),
  sports: sportsOf(org.id as string),
});

const requireOrgAccount = (userId: string) => {
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  if (user.systemRole !== "ORG") throw forbidden("Раздел доступен только аккаунту организации");
};

const requireProfile = (userId: string): Row => {
  const org = db.organizations.find((o) => o.accountId === userId);
  if (!org) throw notFound(NO_PROFILE);
  return org;
};

export function myOrganization(userId: string) {
  requireOrgAccount(userId);
  return organizationResponse(requireProfile(userId));
}

function resolveOrgSports(r: { sportIds?: string[]; sportNames?: string[] }, userId: string, now: number): string[] {
  const ids = new Set<string>();
  for (const id of r.sportIds ?? []) if (id) ids.add(resolveSport(id, null, userId, now).id as string);
  for (const name of r.sportNames ?? []) ids.add(resolveSport(null, name, userId, now).id as string);
  if (!ids.size) throw badRequest("Укажите хотя бы один вид спорта, которым занимается организация");
  if (ids.size > MAX_SPORTS) throw badRequest(`Не больше ${MAX_SPORTS} видов спорта`);
  return [...ids];
}

/**
 * Первая анкета и правка после отказа уходят на проверку (PENDING). Правка анкеты на проверке или одобренной
 * статус не меняет: одобренная организация правит данные без повторной модерации.
 */
export function saveMyOrganization(userId: string, r: any, now: number) {
  requireOrgAccount(userId);
  requireClean(fields("Название", r.name, "Описание", r.description, "Город", r.city));
  const contacts = normalizeContacts(r.contacts);
  let org = db.organizations.find((o) => o.accountId === userId);
  const submitted = !org || org.status === "REJECTED" || org.status === "REVISION";
  const sportIds = resolveOrgSports(r, userId, now);
  if (!org) {
    org = db.organizations.insert({
      id: newId(), city: r.city ?? null, code: null, name: r.name, status: "PENDING", accountId: userId, createdAt: now, updatedAt: now,
      logoFileId: null, reviewedAt: null, description: r.description, submittedAt: now, rejectReason: null, reviewedById: null, contacts,
    });
  } else {
    Object.assign(org, { name: r.name, description: r.description, city: r.city ?? null, contacts, updatedAt: now });
    if (submitted) Object.assign(org, { status: "PENDING", submittedAt: now });
    db.organizations.touch();
  }
  db.organizationSports.removeWhere((s) => s.organizationId === org.id);
  for (const sportId of sportIds) db.organizationSports.insert({ id: newId(), sportId, createdAt: now, updatedAt: now, organizationId: org.id });
  submitModeration("ORGANIZATION", org.id, null, userId, snapshotText(fields("Название", org.name, "Описание", org.description, "Город", org.city)), now);
  // «живой мир»: заявку нового клуба, созданного в браузере, одобряет администратор
  if (submitted && db.credentials.find((c) => c.userId === userId)) schedule("approve-organization", 60_000, { organizationId: org.id });
  if (submitted) {
    publish([{
      key: `${newId()}:ORGANIZATION_SUBMITTED`, recipients: adminIds(), actorId: userId, type: "ORGANIZATION_SUBMITTED", category: "ORGANIZATIONS",
      title: "Новая заявка организации", body: org.name, targetPath: `/admin/organizations/${org.id}`, organizationId: org.id as string,
    }], now);
  }
  return organizationResponse(org);
}

export async function uploadLogo(userId: string, form: FormData | null, now: number) {
  requireOrgAccount(userId);
  const org = requireProfile(userId);
  const old = org.logoFileId ? db.files.get(org.logoFileId) : undefined;
  const logo = await storeUpload("ORG_LOGO", formFile(form), userId, org.id as string, null, null, now);
  org.logoFileId = logo.id;
  db.organizations.touch();
  if (old) deleteFile(old);
  return organizationResponse(org);
}

export function deleteLogo(userId: string) {
  requireOrgAccount(userId);
  const org = requireProfile(userId);
  const old = org.logoFileId ? db.files.get(org.logoFileId) : undefined;
  if (old) {
    org.logoFileId = null;
    db.organizations.touch();
    deleteFile(old);
  }
  return organizationResponse(org);
}

export async function addDocument(userId: string, form: FormData | null, now: number) {
  requireOrgAccount(userId);
  const org = requireProfile(userId);
  if (db.files.rows.filter((f) => f.kind === "ORG_DOCUMENT" && f.organizationId === org.id).length >= MAX_DOCUMENTS) {
    throw conflict(`Можно загрузить не больше ${MAX_DOCUMENTS} документов`);
  }
  await storeUpload("ORG_DOCUMENT", formFile(form), userId, org.id as string, null, null, now);
  return organizationResponse(org);
}

export function removeDocument(userId: string, fileId: string) {
  requireOrgAccount(userId);
  const org = requireProfile(userId);
  const file = db.files.get(fileId);
  if (!file || file.kind !== "ORG_DOCUMENT" || file.organizationId !== org.id) throw notFound("Файл не найден");
  deleteFile(file);
  return organizationResponse(org);
}

// ---------- публичное ----------

const requirePublic = (id: string): Row => {
  const org = db.organizations.get(id);
  if (!org || org.status !== "APPROVED") throw notFound(ORG_NOT_FOUND);
  return org;
};

export function publicOrganization(id: string, now: number) {
  const org = requirePublic(id);
  const stats = hostedStats(null, id, now);
  return {
    id: org.id, name: org.name, description: org.description ?? null, city: org.city ?? null, contacts: org.contacts ?? {},
    logoUrl: fileUrl(org.logoFileId), documents: documentsOf(id), awards: badges(id, now), sports: sportsOf(id),
    hostedMeetings: stats.hostedMeetings, participantsTotal: stats.participantsTotal,
  };
}

export const featuredOrganization = (now: number) => featuredAward(now);

export function cities(): string[] {
  return [...new Set(db.organizations.rows.filter((o) => o.status === "APPROVED" && o.city).map((o) => o.city as string))].sort(cmp);
}

// ---------- подписки ----------

export function subscriptionState(orgId: string, userId: string) {
  const subs = db.organizationSubscriptions.rows.filter((s) => s.organizationId === orgId).sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  return {
    subscribed: subs.some((s) => s.userId === userId),
    subscribersCount: subs.length,
    subscriberAvatars: subs.slice(0, 4).map((s) => userShort(db.users.get(s.userId))),
  };
}

export function changeSubscription(orgId: string, userId: string, subscribe: boolean, now: number) {
  requirePublic(orgId);
  const user = db.users.get(userId) as Row;
  if (user.systemRole !== "USER") throw conflict("Подписываться на организации может только участник с личным аккаунтом");
  const existing = db.organizationSubscriptions.find((s) => s.organizationId === orgId && s.userId === userId);
  if (subscribe && !existing) db.organizationSubscriptions.insert({ id: newId(), userId, createdAt: now, updatedAt: now, organizationId: orgId });
  if (!subscribe && existing) db.organizationSubscriptions.remove(existing.id as string);
  return subscriptionState(orgId, userId);
}

// ---------- встречи клуба ----------

type Snapshot = { all: Row[]; past: Row[]; upcoming: Row[]; events: Map<string, Row>; registered: Map<string, string[]>; attending: Map<string, string[]> };

const zoneOf = (e: Row) => e.timeZone ?? ZONE;
const placeOf = (e: Row) => (e.format === "ONLINE" ? "Онлайн" : (e.address ?? "Место уточняется"));

function snapshotOf(orgId: string, now: number): Snapshot {
  const events = new Map(db.events.rows.filter((e) => e.organizationId === orgId && e.status === "PUBLISHED").map((e) => [e.id as string, e]));
  const all = db.eventOccurrences.rows.filter((o) => events.has(o.eventId) && o.status === "SCHEDULED").sort((a, b) => a.startAt - b.startAt || String(a.id).localeCompare(String(b.id)));
  const registered = new Map<string, string[]>();
  for (const r of db.registrations.rows) {
    if (r.status === "CONFIRMED" && events.has(r.eventId)) registered.set(r.eventId, [...(registered.get(r.eventId) ?? []), r.userId]);
  }
  const occurrenceIds = new Set(all.map((o) => o.id as string));
  const attending = new Map<string, string[]>();
  for (const a of db.occurrenceAttendances.rows) {
    if (occurrenceIds.has(a.occurrenceId)) attending.set(a.occurrenceId, [...(attending.get(a.occurrenceId) ?? []), a.userId]);
  }
  const past = all.filter((o) => endOf(o) <= now).sort((a, b) => b.startAt - a.startAt || String(a.id).localeCompare(String(b.id)));
  return { all, past, upcoming: all.filter((o) => o.startAt > now), events, registered, attending };
}

const peopleOf = (s: Snapshot, o: Row): string[] => {
  const e = s.events.get(o.eventId) as Row;
  const ids = e.recurring ? (s.attending.get(o.id) ?? []) : (s.registered.get(o.eventId) ?? []);
  return [...new Set(ids)].filter((id) => id !== e.authorId);
};

function meetingsPage(s: Snapshot, source: Row[], userId: string, page: number, size: number) {
  const selected = source.slice(page * size, page * size + size);
  const eventIds = new Set(selected.map((o) => o.eventId as string));
  const covers = new Map<string, Row>();
  const photoCounts = new Map<string, number>();
  for (const f of db.files.rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt)) {
    if (!f.eventId || !eventIds.has(f.eventId)) continue;
    if (f.kind === "EVENT_PHOTO" && !covers.has(f.eventId)) covers.set(f.eventId, f);
    if (f.kind === "EVENT_PHOTO" || f.kind === "ALBUM_PHOTO") photoCounts.set(f.eventId, (photoCounts.get(f.eventId) ?? 0) + 1);
  }
  const mine = new Map(db.registrations.rows.filter((r) => r.userId === userId && eventIds.has(r.eventId)).map((r) => [r.eventId as string, r.status as string]));
  const items = selected.map((o) => {
    const e = s.events.get(o.eventId) as Row;
    const people = peopleOf(s, o);
    const cover = covers.get(e.id as string);
    return {
      id: o.id, eventId: e.id, title: e.title, sport: sportResponse(db.sports.get(e.sportId) as Row), startAt: iso(o.startAt), timeZone: zoneOf(e),
      place: placeOf(e), capacity: e.capacity ?? null, attendeesCount: people.length,
      attendees: people.slice(0, 4).map((id) => userShort(db.users.get(id))).filter(Boolean),
      myRegistrationStatus: mine.get(e.id as string) ?? null, coverUrl: cover ? fileUrl(cover.id) : null, coverFocus: cover ? fileFocus(cover) : null,
      photosCount: photoCounts.get(e.id as string) ?? 0,
    };
  });
  return { items, page, size, totalElements: source.length, totalPages: Math.ceil(source.length / size) };
}

const validatePagination = (page: number, size: number) => {
  if (page < 0) throw badRequest("Номер страницы не может быть отрицательным");
  if (size < 1 || size > 100) throw badRequest("Размер страницы должен быть от 1 до 100");
};

export function orgPhotos(orgId: string, page: number, size: number) {
  requirePublic(orgId);
  validatePagination(page, size);
  const events = new Set(db.events.rows.filter((e) => e.organizationId === orgId && e.status === "PUBLISHED").map((e) => e.id as string));
  const all = db.files.rows
    .filter((f) => (f.kind === "EVENT_PHOTO" || f.kind === "ALBUM_PHOTO") && f.eventId && events.has(f.eventId))
    .sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)));
  return { items: all.slice(page * size, page * size + size).map(fileResponse), page, size, totalElements: all.length, totalPages: Math.ceil(all.length / size) };
}

export function pastMeetings(orgId: string, userId: string, sportId: string | undefined, page: number, size: number, now: number) {
  validatePagination(page, size);
  requirePublic(orgId);
  const s = snapshotOf(orgId, now);
  const filtered = s.past.filter((o) => !sportId || s.events.get(o.eventId)?.sportId === sportId);
  return meetingsPage(s, filtered, userId, page, size);
}

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

export function overview(orgId: string, userId: string, now: number) {
  const org = requirePublic(orgId);
  const s = snapshotOf(orgId, now);
  const year = now - 365 * 86_400_000;
  const visits = new Map<string, number>();
  const yearPeople = new Set<string>();
  for (const o of s.past) {
    for (const u of peopleOf(s, o)) {
      visits.set(u, (visits.get(u) ?? 0) + 1);
      if (o.startAt >= year) yearPeople.add(u);
    }
  }
  const earnedMonths = new Set(db.organizationAwards.rows.filter((a) => a.organizationId === orgId && a.kind === "ORG_OF_MONTH" && a.status === "CONFIRMED").map((a) => a.period as string));
  const current = partsIn(now, ZONE);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const index = current.y * 12 + (current.m - 1) - i;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    const first = isoDate(y, m, 1);
    months.push({
      month: first,
      count: s.past.filter((o) => monthKey(o.startAt, zoneOf(s.events.get(o.eventId) as Row)) === index).length,
      awardMonth: earnedMonths.has(first),
      current: i === 0,
    });
  }
  const schedule = new Map<string, unknown>();
  for (const o of s.upcoming.filter((x) => x.startAt < now + 28 * 86_400_000)) {
    const e = s.events.get(o.eventId) as Row;
    const day = DAYS[partsIn(o.startAt, zoneOf(e)).dow - 1];
    if (!schedule.has(day)) schedule.set(day, { day, eventId: e.id, startAt: iso(o.startAt), timeZone: zoneOf(e), title: e.title, place: placeOf(e) });
  }
  const leaderEvents = new Map<string, Set<string>>();
  for (const e of s.events.values()) leaderEvents.set(e.authorId, (leaderEvents.get(e.authorId) ?? new Set()).add(e.id as string));
  for (const co of db.eventOrganizers.rows) if (s.events.has(co.eventId)) leaderEvents.set(co.userId, (leaderEvents.get(co.userId) ?? new Set()).add(co.eventId));
  leaderEvents.delete(org.accountId);
  const leaders = [...leaderEvents.entries()]
    .filter(([id]) => db.users.get(id))
    .map(([id, ids]) => ({ user: userShort(db.users.get(id)), meetingsCount: s.all.filter((o) => ids.has(o.eventId)).length }))
    .sort((a, b) => b.meetingsCount - a.meetingsCount || String(a.user?.id).localeCompare(String(b.user?.id)));
  const placeCounts = new Map<string, number>();
  for (const o of s.all) {
    const p = placeOf(s.events.get(o.eventId) as Row);
    placeCounts.set(p, (placeCounts.get(p) ?? 0) + 1);
  }
  const places = [...placeCounts.entries()].map(([name, meetingsCount]) => ({ name, meetingsCount })).sort((a, b) => b.meetingsCount - a.meetingsCount || cmp(a.name, b.name)).slice(0, 4);
  const sportCounts = new Map<string, number>();
  for (const o of s.past) {
    const id = (s.events.get(o.eventId) as Row).sportId;
    sportCounts.set(id, (sportCounts.get(id) ?? 0) + 1);
  }
  const pastSports = [...sportCounts.entries()]
    .map(([id, count]) => ({ sport: sportResponse(db.sports.get(id) as Row), count }))
    .sort((a, b) => b.count - a.count || cmp(a.sport.name, b.sport.name));
  const eventPhotoFiles = db.files.rows.filter((f) => (f.kind === "EVENT_PHOTO" || f.kind === "ALBUM_PHOTO") && f.eventId && s.events.has(f.eventId));
  const firstYear = s.all.length ? Math.min(...s.all.map((o) => partsIn(o.startAt, zoneOf(s.events.get(o.eventId) as Row)).y)) : null;
  const returning = [...visits.values()].filter((v) => v >= 2).length;
  return {
    firstEventYear: firstYear,
    hostedMeetings: s.past.length,
    yearParticipants: yearPeople.size,
    photosCount: eventPhotoFiles.length,
    photoMeetingsCount: new Set(eventPhotoFiles.map((f) => f.eventId)).size,
    returningShare: visits.size < 5 ? null : Math.round((100 * returning) / visits.size),
    petName: db.users.get(userId)?.petName ?? "Бублик",
    subscription: subscriptionState(orgId, userId),
    months,
    schedule: DAYS.filter((d) => schedule.has(d)).map((d) => schedule.get(d)),
    leaders,
    places,
    pastSports,
    upcoming: meetingsPage(s, s.upcoming, userId, 0, 3),
    past: meetingsPage(s, s.past, userId, 0, 4),
    photos: orgPhotos(orgId, 0, 6),
  };
}

export function catalog(userId: string, searchText: string | undefined, city: string | undefined, sportId: string | undefined, mine: boolean, page: number, size: number, now: number) {
  validatePagination(page, size);
  const q = (searchText ?? "").trim().toLowerCase();
  const c = (city ?? "").trim().toLowerCase();
  const subs = new Set(db.organizationSubscriptions.rows.filter((s) => s.userId === userId).map((s) => s.organizationId as string));
  const confirmed = new Set(db.registrations.rows.filter((r) => r.userId === userId && r.status === "CONFIRMED").map((r) => r.eventId as string));
  const marked = new Set(db.occurrenceAttendances.rows.filter((a) => a.userId === userId).map((a) => a.occurrenceId as string));
  const attendedOrgs = new Set<string>();
  const hosted = new Map<string, number>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt >= now) continue;
    const e = db.events.get(o.eventId);
    if (!e || !e.organizationId || e.status !== "PUBLISHED") continue;
    if (e.recurring ? marked.has(o.id as string) : confirmed.has(e.id as string)) attendedOrgs.add(e.organizationId);
    if (endOf(o) <= now) hosted.set(e.organizationId, (hosted.get(e.organizationId) ?? 0) + 1);
  }
  const found = db.organizations.rows
    .filter((o) => o.status === "APPROVED")
    .filter((o) => String(o.name).toLowerCase().includes(q) || String(o.description ?? "").toLowerCase().includes(q))
    .filter((o) => !c || String(o.city ?? "").toLowerCase() === c)
    .filter((o) => !sportId || db.organizationSports.rows.some((s) => s.organizationId === o.id && s.sportId === sportId))
    .filter((o) => !mine || subs.has(o.id as string) || attendedOrgs.has(o.id as string))
    .sort((a, b) => cmp(String(a.name), String(b.name)) || String(a.id).localeCompare(String(b.id)));
  const awardMonth = new Map<string, string>();
  for (const a of db.organizationAwards.rows) {
    if (a.kind === "ORG_OF_MONTH" && a.status === "CONFIRMED" && (!awardMonth.has(a.organizationId) || String(a.period) > (awardMonth.get(a.organizationId) as string))) awardMonth.set(a.organizationId, a.period);
  }
  const counts = new Map<string, number>();
  for (const s of db.organizationSubscriptions.rows) counts.set(s.organizationId, (counts.get(s.organizationId) ?? 0) + 1);
  const slice = found.slice(page * size, page * size + size);
  return {
    items: slice.map((o) => ({
      id: o.id, name: o.name, description: o.description ?? null, city: o.city ?? null, logoUrl: fileUrl(o.logoFileId), sports: sportsOf(o.id as string),
      hostedMeetings: hosted.get(o.id as string) ?? 0, subscribersCount: counts.get(o.id as string) ?? 0, subscribed: subs.has(o.id as string),
      attended: attendedOrgs.has(o.id as string), awardMonth: awardMonth.get(o.id as string) ?? null,
    })),
    page, size, totalElements: found.length, totalPages: Math.ceil(found.length / size),
  };
}

// ---------- админка: допуск ----------

function adminOrganization(org: Row, full: boolean) {
  const account = db.users.get(org.accountId);
  return {
    id: org.id, name: org.name, description: org.description ?? null, city: org.city ?? null, contacts: org.contacts ?? {}, status: org.status,
    rejectReason: org.rejectReason ?? null, submittedAt: iso(org.submittedAt), reviewedAt: iso(org.reviewedAt), reviewedById: org.reviewedById ?? null,
    account: account ? { id: account.id, username: account.username, email: account.email, firstName: account.firstName, lastName: account.lastName } : null,
    createdAt: iso(org.createdAt), updatedAt: iso(org.updatedAt), logoUrl: fileUrl(org.logoFileId),
    documents: full ? documentsOf(org.id as string) : [], sports: sportsOf(org.id as string),
    eventsCount: full ? db.events.rows.filter((e) => e.organizationId === org.id).length : 0,
  };
}

export function adminListOrganizations(status: string | undefined, searchText: string | undefined, page: number, size: number) {
  const q = (searchText ?? "").trim().toLowerCase();
  const found = db.organizations.rows
    .filter((o) => (!status || o.status === status) && String(o.name).toLowerCase().includes(q))
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  const s = Math.min(Math.max(size, 1), 100);
  const p = Math.max(page, 0);
  return { items: found.slice(p * s, p * s + s).map((o) => adminOrganization(o, false)), page: p, size: s, totalElements: found.length, totalPages: Math.ceil(found.length / s) };
}

const findOrg = (id: string): Row => {
  const org = db.organizations.get(id);
  if (!org) throw notFound(ORG_NOT_FOUND);
  return org;
};

export const adminGetOrganization = (id: string) => adminOrganization(findOrg(id), true);

function decide(org: Row, status: string, reason: string | null, adminId: string, now: number) {
  const cleaned = reason && reason.trim() ? reason.trim() : null;
  const changed = org.status !== status || (org.rejectReason ?? null) !== cleaned;
  Object.assign(org, { status, rejectReason: status === "APPROVED" ? null : cleaned, reviewedAt: now, reviewedById: adminId, updatedAt: now });
  db.organizations.touch();
  if (status !== "APPROVED") resolveModeration("ORGANIZATION", org.id as string, "ACTION_TAKEN", adminId, now);
  if (changed) {
    const type = status === "APPROVED" ? "ORGANIZATION_APPROVED" : status === "REVISION" ? "ORGANIZATION_RETURNED" : "ORGANIZATION_REJECTED";
    const title = status === "APPROVED" ? "Организация одобрена" : status === "REVISION" ? "Анкету вернули на доработку" : "Организация отклонена";
    publish([{
      key: `${newId()}:${type}`, recipients: [org.accountId], actorId: adminId, type, category: "ORGANIZATIONS", title,
      body: org.name + (org.rejectReason ? `\n${org.rejectReason}` : ""), targetPath: "/org", organizationId: org.id as string,
    }], now);
  }
  return adminOrganization(org, true);
}

export function adminApprove(id: string, adminId: string, now: number) {
  const org = findOrg(id);
  if (org.status === "APPROVED") return adminOrganization(org, true);
  return decide(org, "APPROVED", null, adminId, now);
}

export const adminReject = (id: string, adminId: string, reason: string, now: number) => decide(findOrg(id), "REJECTED", reason, adminId, now);

export function adminReturn(id: string, adminId: string, reason: string, now: number) {
  const org = findOrg(id);
  if (org.status !== "PENDING" && org.status !== "REVISION") throw conflict("На доработку возвращается только заявка на проверке");
  return decide(org, "REVISION", reason, adminId, now);
}

