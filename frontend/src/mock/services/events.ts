// Мероприятия (порт EventService, EventListLookups, EventMapService, EventOrganizerService и EventMapper):
// лента, карточка, мои, карта, создание и правка, объявления, фото, соорганизаторы, календарь .ics.
import { db, type Row } from "../db";
import { badRequest, collectErrors, conflict, forbidden, notFound, Query, throwIfInvalid } from "../http";
import { schedule } from "../life/jobs";
import { newId } from "../util/ids";
import { DAY } from "../util/time";
import { watch } from "./changes";
import { fileResponse, fileFocus, iso, orgShort, organizationOfAccount, sportResponse, userShort } from "./common";
import { requireClean, snapshotText, fields, submit as submitModeration } from "./moderation";
import { eventCovers, eventPhotosOf, deleteFile, requireFile, setFocus, storeUpload, formFile } from "./files";
import { publish } from "./notify";
import {
  applyOccurrences, calendarOccurrences, descriptions, EVENT_NOT_FOUND, FAR_FUTURE, maxFutureAttendance, nextOccurrence,
  scheduleResponse, singleOccurrence,
} from "./occurrences";
import { participants as petParticipants } from "./pets";
import {
  addOrganizerBlockedReason, canManage, canManageOrganizers, canSeePrivateDetails, cancelBlockedReason, commentBlockedReason,
  createBlockedReason, isAuthor, isOrganizer, joinAs, manageConflictReason,
  organizerIds, quorumStatus, registerBlockedReason, registrationOf,
} from "./policy";
import { expand } from "./schedule";
import { resolveSport, sportPreferences } from "./sports";
import { promoteWaitlist, waitlistPosition } from "./waitlist";

export { EVENT_NOT_FOUND };
const FEED_LIMIT = 100;
const DEFAULT_RADIUS_KM = 10;
const MAX_PHOTOS = 6;
const MAP_LIMIT = 1000;
const DEFAULT_WINDOW = 30 * DAY;

const requireEvent = (id: string): Row => {
  const e = db.events.get(id);
  if (!e) throw notFound(EVENT_NOT_FOUND);
  return e;
};

// ---------- карточки списков ----------

type Lookups = ReturnType<typeof loadLookups>;

function loadLookups(list: Row[], userId: string, from: number, to: number) {
  const ids = new Set(list.map((e) => e.id as string));
  const confirmed = new Map<string, number>();
  const confirmedRegs = new Map<string, Row[]>();
  const myStatus = new Map<string, string>();
  for (const r of db.registrations.rows) {
    if (!ids.has(r.eventId)) continue;
    if (r.userId === userId) myStatus.set(r.eventId, r.status);
    if (r.status === "CONFIRMED") {
      confirmed.set(r.eventId, (confirmed.get(r.eventId) ?? 0) + 1);
      confirmedRegs.set(r.eventId, [...(confirmedRegs.get(r.eventId) ?? []), r]);
    }
  }
  const next = new Map<string, Row>();
  const cancelledSingle = new Set<string>();
  for (const o of db.eventOccurrences.rows) {
    if (!ids.has(o.eventId)) continue;
    if (o.status === "CANCELLED") cancelledSingle.add(o.eventId);
    if (o.status !== "SCHEDULED" || o.startAt < from || o.startAt > to) continue;
    const cur = next.get(o.eventId);
    if (!cur || o.startAt < cur.startAt) next.set(o.eventId, o);
  }
  const attendeesByOccurrence = new Map<string, Set<string>>();
  const seriesNextIds = new Set(list.filter((e) => e.recurring).map((e) => next.get(e.id as string)?.id).filter(Boolean) as string[]);
  for (const a of db.occurrenceAttendances.rows) {
    if (!seriesNextIds.has(a.occurrenceId)) continue;
    const set = attendeesByOccurrence.get(a.occurrenceId) ?? new Set<string>();
    set.add(a.userId);
    attendeesByOccurrence.set(a.occurrenceId, set);
  }
  return {
    confirmed, confirmedRegs, myStatus, next, attendeesByOccurrence,
    cancelledSingle: new Set([...cancelledSingle].filter((id) => list.some((e) => e.id === id && !e.recurring))),
    schedules: descriptions(list),
  };
}

function nextAttendees(event: Row, l: Lookups): number | null {
  const next = l.next.get(event.id as string);
  if (!event.recurring || !next) return null;
  return l.attendeesByOccurrence.get(next.id as string)?.size ?? 0;
}

function summaryOf(event: Row, l: Lookups, covers: Map<string, Row>, previews: Map<string, unknown[]>) {
  const next = l.next.get(event.id as string);
  const count = l.confirmed.get(event.id as string) ?? 0;
  const attendees = nextAttendees(event, l);
  const quorum = next ? quorumStatus(event, next, event.recurring ? (attendees as number) : count) : null;
  const cover = covers.get(event.id as string);
  const org = event.organizationId ? db.organizations.get(event.organizationId) : null;
  return {
    id: event.id,
    title: event.title,
    sport: sportResponse(db.sports.get(event.sportId) as Row),
    startAt: iso(next ? next.startAt : event.startAt),
    endAt: iso(next ? next.endAt : event.endAt),
    occurrenceId: next?.id ?? null,
    recurring: !!event.recurring,
    scheduleDescription: l.schedules.get(event.id as string) ?? null,
    format: event.format,
    address: event.address ?? null,
    locationNote: event.locationNote ?? null,
    lat: event.lat ?? null,
    lon: event.lon ?? null,
    level: event.level,
    kind: event.kind ?? null,
    joinMode: event.joinMode,
    capacity: event.capacity ?? null,
    participantsCount: count,
    occurrenceAttendeesCount: attendees,
    participantsPreview: previews.get(event.id as string) ?? [],
    minParticipants: event.minParticipants ?? null,
    quorumStatus: quorum,
    cancelledByOrganizer: l.cancelledSingle.has(event.id as string),
    status: event.status,
    moderationReason: event.moderationReason ?? null,
    authorId: event.authorId,
    organizationId: event.organizationId ?? null,
    organizer: userShort(db.users.get(event.authorId)),
    organization: orgShort(org),
    myRegistrationStatus: l.myStatus.get(event.id as string) ?? null,
    coverUrl: cover ? fileResponse(cover).url : null,
    coverFocus: cover ? fileFocus(cover) : null,
  };
}

/** Список для ленты и «моих»: счётчики и мои статусы считаются один раз на весь список. */
export function summaries(list: Row[], userId: string, from: number, to: number | null = null) {
  if (!list.length) return [];
  const l = loadLookups(list, userId, from, to ?? FAR_FUTURE);
  const covers = eventCovers(new Set(list.map((e) => e.id as string)));
  const previewUsers = new Map<string, Row[]>();
  for (const event of list) {
    const regs = [...(l.confirmedRegs.get(event.id as string) ?? [])].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
    const next = l.next.get(event.id as string);
    const attending = event.recurring && next ? l.attendeesByOccurrence.get(next.id as string) : null;
    const users: Row[] = [];
    for (const r of regs) {
      if (users.length >= 3) break;
      if (event.recurring && next && !attending?.has(r.userId)) continue;
      const u = db.users.get(r.userId);
      if (u) users.push(u);
    }
    previewUsers.set(event.id as string, users);
  }
  const flat = [...new Set([...previewUsers.values()].flat())];
  const petById = new Map(petParticipants(flat).map((p) => [p.id as string, p]));
  const previews = new Map<string, unknown[]>();
  for (const [id, users] of previewUsers) previews.set(id, users.map((u) => petById.get(u.id as string)));
  return list.map((e) => summaryOf(e, l, covers, previews));
}

// ---------- лента ----------

export type FeedFilter = {
  searchText?: string; sportId?: string; from?: number; to?: number; level?: string; joinMode?: string; format?: string;
  organizationId?: string; forMe?: boolean; lat?: number; lon?: number; radiusKm?: number; page?: number; size?: number;
};

const visibleOrganization = (event: Row) => !event.organizationId || db.organizations.get(event.organizationId)?.status === "APPROVED";

function textMatches(event: Row, search: string): boolean {
  const lower = search.toLowerCase();
  const sportPattern = lower.replaceAll("ё", "е");
  const sport = db.sports.get(event.sportId);
  const org = event.organizationId ? db.organizations.get(event.organizationId) : null;
  return (
    String(event.title).toLowerCase().includes(lower) ||
    String(event.description ?? "").toLowerCase().includes(lower) ||
    String(event.address ?? "").toLowerCase().includes(lower) ||
    String(sport?.normalizedName ?? "").includes(sportPattern) ||
    String(org?.name ?? "").toLowerCase().includes(lower)
  );
}

function nearBox(lat: number, lon: number, radiusKm: number) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

/** Условия на само мероприятие — общие для ленты и карты. */
function feedPredicate(f: FeedFilter, userId: string) {
  const prefs = f.forMe ? sportPreferences(userId) : null;
  const near = f.lat != null && f.lon != null ? nearBox(f.lat, f.lon, f.radiusKm ?? DEFAULT_RADIUS_KM) : null;
  const search = f.searchText?.trim() || null;
  return (e: Row) => {
    if (e.status !== "PUBLISHED" || !visibleOrganization(e)) return false;
    if (search && !textMatches(e, search)) return false;
    if (f.sportId && e.sportId !== f.sportId) return false;
    if (f.level && e.level !== f.level) return false;
    if (f.joinMode && e.joinMode !== f.joinMode) return false;
    if (f.organizationId && e.organizationId !== f.organizationId) return false;
    if (f.format && e.format !== f.format) return false;
    if (prefs) {
      if (!prefs.has(e.sportId)) return false;
      const level = prefs.get(e.sportId);
      if (level != null && e.level !== level && e.level !== "ANY") return false;
    }
    if (near && e.format !== "ONLINE") {
      if (e.lat == null || e.lon == null || e.lat < near.minLat || e.lat > near.maxLat || e.lon < near.minLon || e.lon > near.maxLon) return false;
    }
    return true;
  };
}

/** Ближайшее подходящее занятие каждого мероприятия в [from, to]. */
function nearestStarts(from: number, to: number | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt < from || (to !== null && o.startAt > to)) continue;
    const cur = out.get(o.eventId);
    if (cur === undefined || o.startAt < cur) out.set(o.eventId, o.startAt);
  }
  return out;
}

export function listEvents(f: FeedFilter, userId: string, now: number) {
  const from = f.from ?? now;
  if ((f.lat == null) !== (f.lon == null)) throw badRequest("Для поиска рядом укажите и широту, и долготу");
  const matches = feedPredicate(f, userId);
  const starts = nearestStarts(from, f.to ?? null);
  const found = db.events.rows
    .filter((e) => starts.has(e.id as string) && matches(e))
    .sort((a, b) => (starts.get(a.id) as number) - (starts.get(b.id) as number) || String(a.id).localeCompare(String(b.id)));
  const size = Math.max(1, f.size ?? FEED_LIMIT);
  const page = Math.max(0, f.page ?? 0);
  const slice = found.slice(page * size, page * size + size);
  return {
    items: summaries(slice, userId, from, f.to ?? null),
    page,
    size,
    totalElements: found.length,
    totalPages: Math.ceil(found.length / size),
  };
}

export function mineEvents(userId: string, status: string | undefined, when: string | undefined, searchText: string | undefined, page: number, size: number, now: number) {
  const search = searchText?.trim().toLowerCase();
  const hasFuture = (id: string) => db.eventOccurrences.rows.some((o) => o.eventId === id && o.status === "SCHEDULED" && o.startAt > now);
  const found = db.events.rows
    .filter((e) => e.authorId === userId || db.eventOrganizers.rows.some((o) => o.eventId === e.id && o.userId === userId))
    .filter((e) => !status || e.status === status)
    .filter((e) => !search || String(e.title).toLowerCase().includes(search))
    .filter((e) => !when || (when === "UPCOMING" ? hasFuture(e.id as string) : !hasFuture(e.id as string)))
    .sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const s = Math.min(Math.max(size, 1), 100);
  const p = Math.max(0, page);
  const slice = found.slice(p * s, p * s + s);
  return { items: summaries(slice, userId, now), page: p, size: s, totalElements: found.length, totalPages: Math.ceil(found.length / s) };
}

// ---------- карта ----------

export type MapFilter = FeedFilter & { minLon: number; minLat: number; maxLon: number; maxLat: number; mine?: boolean };

export function mapEvents(f: MapFilter, userId: string, now: number) {
  if (f.minLat > f.maxLat) throw badRequest("Южная граница области должна быть не севернее северной");
  if ((f.lat == null) !== (f.lon == null)) throw badRequest("Для поиска рядом укажите и широту, и долготу");
  const from = f.from != null && f.from > now ? f.from : now;
  const to = f.to ?? from + DEFAULT_WINDOW;
  if (to < from) throw badRequest("Конец периода должен быть позже начала и не в прошлом");
  const matches = feedPredicate(f, userId);
  const starts = nearestStarts(from, to);
  const inArea = (e: Row) => {
    if (e.format !== "OFFLINE" || e.lat == null || e.lon == null || e.lat < f.minLat || e.lat > f.maxLat) return false;
    return f.minLon <= f.maxLon ? e.lon >= f.minLon && e.lon <= f.maxLon : e.lon >= f.minLon || e.lon <= f.maxLon;
  };
  const found = db.events.rows
    .filter((e) => starts.has(e.id as string) && matches(e) && inArea(e))
    .filter((e) => !f.mine || e.authorId === userId || db.eventOrganizers.rows.some((o) => o.eventId === e.id && o.userId === userId))
    .sort((a, b) => (starts.get(a.id) as number) - (starts.get(b.id) as number) || String(a.id).localeCompare(String(b.id)));
  const truncated = found.length > MAP_LIMIT;
  const shown = truncated ? found.slice(0, MAP_LIMIT) : found;
  const l = loadLookups(shown, userId, from, to);
  return {
    type: "FeatureCollection",
    features: shown.map((event) => {
      const next = l.next.get(event.id as string);
      return {
        type: "Feature",
        id: event.id,
        geometry: { type: "Point", coordinates: [event.lon, event.lat] },
        properties: {
          id: event.id,
          title: event.title,
          sport: sportResponse(db.sports.get(event.sportId) as Row),
          startAt: iso(next ? next.startAt : event.startAt),
          endAt: iso(next ? next.endAt : event.endAt),
          occurrenceId: next?.id ?? null,
          recurring: !!event.recurring,
          scheduleDescription: l.schedules.get(event.id as string) ?? null,
          address: event.address ?? null,
          level: event.level,
          joinMode: event.joinMode,
          participantsCount: l.confirmed.get(event.id as string) ?? 0,
          capacity: event.capacity ?? null,
          myRegistrationStatus: l.myStatus.get(event.id as string) ?? null,
        },
      };
    }),
    truncated,
    limit: MAP_LIMIT,
  };
}

// ---------- соорганизаторы ----------

const isInvited = (eventId: string, userId: string) =>
  db.organizerInvitations.rows.some((i) => i.eventId === eventId && i.userId === userId && i.status === "PENDING");

/** Состав для карточки: автор первым, дальше соорганизаторы; организаторам ещё и приглашённые без ответа. */
export function organizersOf(event: Row, viewerId: string | null) {
  const co = db.eventOrganizers.rows.filter((o) => o.eventId === event.id).sort((a, b) => a.createdAt - b.createdAt);
  const invited = viewerId && isOrganizer(event, viewerId)
    ? db.organizerInvitations.rows.filter((i) => i.eventId === event.id && i.status === "PENDING").sort((a, b) => a.createdAt - b.createdAt)
    : [];
  const entry = (userId: string, author: boolean, isInvitedFlag: boolean) => ({
    user: userShort(db.users.get(userId)),
    author,
    organization: orgShort(organizationOfAccount(userId)),
    invited: isInvitedFlag,
  });
  return [entry(event.authorId, true, false), ...co.map((o) => entry(o.userId, false, false)), ...invited.map((i) => entry(i.userId, false, true))];
}

function eventManagedByAuthor(eventId: string, userId: string): Row {
  const event = requireEvent(eventId);
  watch(eventId, userId);
  if (!isAuthor(event, userId)) throw forbidden("Состав организаторов меняет только автор мероприятия");
  if (!canManageOrganizers(event, userId)) throw conflict(manageConflictReason(event, "Мероприятие удалено, менять организаторов нельзя"));
  return event;
}

export function inviteOrganizer(eventId: string, userId: string, login: string, now: number) {
  const event = eventManagedByAuthor(eventId, userId);
  const key = login.trim().toLowerCase();
  const invitee = db.users.find((u) => u.active && (String(u.username).toLowerCase() === key || String(u.email).toLowerCase() === key));
  if (!invitee) throw notFound("Пользователь не найден");
  const blocked = addOrganizerBlockedReason(event, invitee, registrationOf(eventId, invitee.id as string));
  if (blocked) throw conflict(blocked);
  const existing = db.organizerInvitations.find((i) => i.eventId === eventId && i.userId === invitee.id);
  if (!existing) {
    db.organizerInvitations.insert({ id: newId(), status: "PENDING", userId: invitee.id, eventId, createdAt: now, decidedAt: null, updatedAt: now, invitedById: userId });
  } else if (existing.status === "PENDING") {
    throw conflict("Приглашение уже отправлено — ждём ответа");
  } else {
    Object.assign(existing, { status: "PENDING", decidedAt: null, invitedById: userId, updatedAt: now });
    db.organizerInvitations.touch();
  }
  return organizersOf(event, userId);
}

export function myInvitations(userId: string) {
  return db.organizerInvitations.rows
    .filter((i) => i.userId === userId && i.status === "PENDING")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((i) => {
      const e = db.events.get(i.eventId);
      return !!e && e.status !== "DELETED";
    })
    .map((i) => ({
      eventId: i.eventId,
      eventTitle: (db.events.get(i.eventId) as Row).title,
      invitedBy: userShort(db.users.get(i.invitedById)),
      invitedAt: iso(i.updatedAt),
    }));
}

const pendingInvitation = (eventId: string, userId: string): Row => {
  const i = db.organizerInvitations.find((x) => x.eventId === eventId && x.userId === userId && x.status === "PENDING");
  if (!i) throw notFound("Приглашения нет: его отозвали или вы уже ответили");
  return i;
};

export function acceptInvitation(eventId: string, userId: string, now: number) {
  const event = requireEvent(eventId);
  watch(eventId, userId);
  const invitation = pendingInvitation(eventId, userId);
  if (!canManageOrganizers(event, event.authorId)) throw conflict(manageConflictReason(event, "Мероприятие удалено, стать организатором нельзя"));
  const me = db.users.get(userId) as Row;
  if (addOrganizerBlockedReason(event, me, registrationOf(eventId, userId))) {
    throw conflict(isOrganizer(event, userId) ? "Вы уже организатор этого мероприятия" : "Вы записаны участником: сначала отмените запись, потом примите приглашение");
  }
  db.eventOrganizers.insert({ id: newId(), userId, eventId, addedById: invitation.invitedById, createdAt: now, updatedAt: now });
  Object.assign(invitation, { status: "ACCEPTED", decidedAt: now, updatedAt: now });
  db.organizerInvitations.touch();
  return myInvitations(userId);
}

export function declineInvitation(eventId: string, userId: string, now: number) {
  requireEvent(eventId);
  watch(eventId, userId);
  Object.assign(pendingInvitation(eventId, userId), { status: "DECLINED", decidedAt: now, updatedAt: now });
  db.organizerInvitations.touch();
  return myInvitations(userId);
}

export function removeOrganizer(eventId: string, userId: string, organizerId: string, now: number) {
  const event = requireEvent(eventId);
  watch(eventId, userId);
  if (isAuthor(event, organizerId)) throw conflict("Автора мероприятия убрать из организаторов нельзя");
  const leavingMyself = userId === organizerId;
  if (!leavingMyself) eventManagedByAuthor(eventId, userId);
  const co = db.eventOrganizers.find((o) => o.eventId === eventId && o.userId === organizerId);
  if (co) {
    db.eventOrganizers.remove(co.id as string);
    return organizersOf(event, userId);
  }
  const invitation = leavingMyself ? null : db.organizerInvitations.find((i) => i.eventId === eventId && i.userId === organizerId && i.status === "PENDING");
  if (!invitation) throw notFound("Этот пользователь не организатор мероприятия");
  Object.assign(invitation, { status: "CANCELLED", decidedAt: now, updatedAt: now });
  db.organizerInvitations.touch();
  return organizersOf(event, userId);
}

// ---------- карточка ----------

export function getEvent(eventId: string, userId: string, now: number) {
  const event = requireEvent(eventId);
  const sport = db.sports.get(event.sportId) as Row;
  const author = db.users.get(event.authorId);
  const organization = event.organizationId ? db.organizations.get(event.organizationId) : null;
  const confirmed = db.registrations.rows
    .filter((r) => r.eventId === eventId && r.status === "CONFIRMED")
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  const users = confirmed.map((r) => db.users.get(r.userId)).filter(Boolean) as Row[];
  const mine = registrationOf(eventId, userId);
  const role = db.users.get(userId)?.systemRole;
  const privateOk = canSeePrivateDetails(event, userId, mine);
  const blocked = registerBlockedReason(event, role, userId, mine, users.length, now);
  const viewer = {
    registrationStatus: mine?.status ?? null,
    canRegister: blocked === null,
    registerBlockedReason: blocked,
    isOrganizer: isOrganizer(event, userId),
    canManage: canManage(event, userId),
    canManageOrganizers: canManageOrganizers(event, userId),
    canCancel: cancelBlockedReason(event, mine, now) === null,
    canSeePrivateDetails: privateOk,
    canComment: commentBlockedReason(event) === null,
    joinAs: blocked === null ? joinAs(event, users.length) : null,
    waitlistPosition: waitlistPosition(mine),
    decisionReason: mine?.status === "REJECTED" ? (mine.decisionReason ?? null) : null,
    organizerInvite: isInvited(eventId, userId),
  };
  return {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    sport: sportResponse(sport),
    author: userShort(author),
    organizers: organizersOf(event, userId),
    organizationId: event.organizationId ?? null,
    organization: orgShort(organization),
    startAt: iso(event.startAt),
    endAt: iso(event.endAt),
    recurring: !!event.recurring,
    schedule: scheduleResponse(event),
    nextOccurrence: nextOccurrence(event, now),
    format: event.format,
    address: event.address ?? null,
    locationNote: event.locationNote ?? null,
    onlineUrl: privateOk ? (event.onlineUrl ?? null) : null,
    lat: event.lat ?? null,
    lon: event.lon ?? null,
    level: event.level,
    kind: event.kind ?? null,
    requirements: event.requirements ?? null,
    equipment: event.equipment ?? null,
    privateDetails: privateOk ? (event.privateDetails ?? null) : null,
    capacity: event.capacity ?? null,
    minParticipants: event.minParticipants ?? null,
    singleOccurrence: singleOccurrence(event, userId, now),
    participantsCount: users.length,
    participants: petParticipants(users),
    joinMode: event.joinMode,
    status: event.status,
    moderationReason: event.moderationReason ?? null,
    moderatedAt: iso(event.moderatedAt),
    announcement: event.announcement ?? null,
    announcedAt: iso(event.announcedAt),
    photos: eventPhotosOf(eventId).map(fileResponse),
    viewer,
    createdAt: iso(event.createdAt),
    updatedAt: iso(event.updatedAt),
  };
}

export function createPermission(userId: string) {
  const user = db.users.get(userId);
  const organization = user?.systemRole === "ORG" ? organizationOfAccount(userId) : undefined;
  const reason = user ? createBlockedReason(user, organization) : null;
  return { canCreate: reason === null, reason };
}

// ---------- создание и правка ----------

type EventRequest = Record<string, any>;

const parseInstant = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
};

/** Проверки формы (Bean Validation у EventRequest): вложенное расписание проверяется отдельно, пути полей как у бэкенда. */
function validateForm(r: EventRequest) {
  const errors = collectErrors(r, {
    title: { required: true, max: 200 }, description: { max: 5000 }, sportName: { max: 100 }, format: { notNull: true }, address: { max: 500 },
    locationNote: { max: 1000 }, onlineUrl: { max: 1000 }, lat: { minValue: -90, maxValue: 90 }, lon: { minValue: -180, maxValue: 180 },
    requirements: { max: 2000 }, equipment: { max: 2000 }, capacity: { minValue: 1, maxValue: 10000 }, privateDetails: { max: 2000 },
    minParticipants: { minValue: 1, maxValue: 10000 },
  });
  if (r.schedule) {
    collectErrors(r.schedule, { timeZone: { required: true, max: 64 }, startDate: { notNull: true }, endDate: { notNull: true }, rules: { notEmpty: true, maxItems: 10 } }, errors, "schedule.");
    (r.schedule.rules ?? []).forEach((rule: any, i: number) =>
      collectErrors(rule, { firstStart: { notNull: true }, durationMinutes: { notNull: true, minValue: 1, maxValue: 1440 }, rrule: { required: true, max: 500 } }, errors, `schedule.rules[${i}].`),
    );
  }
  throwIfInvalid(errors);
}

function validate(r: EventRequest, now: number) {
  validateForm(r);
  if (r.minParticipants != null && r.capacity != null && r.minParticipants > r.capacity) throw badRequest("Кворум не может быть больше лимита мест");
  if (!r.schedule) {
    const start = parseInstant(r.startAt);
    const end = parseInstant(r.endAt);
    if (start === null) throw badRequest("Укажите время начала");
    if (start <= now) throw badRequest("Начало должно быть в будущем");
    if (end !== null && end <= start) throw badRequest("Окончание должно быть позже начала");
  } else if (r.startAt || r.endAt) {
    throw badRequest("У повторяющегося мероприятия время задаётся расписанием: не передавайте startAt и endAt");
  }
  if (r.format === "OFFLINE" && !String(r.address ?? "").trim()) throw badRequest("Для очного мероприятия нужен адрес");
  if (r.format === "ONLINE" && !String(r.onlineUrl ?? "").trim()) throw badRequest("Для онлайн-мероприятия нужна ссылка на встречу");
  if ((r.lat == null) !== (r.lon == null)) throw badRequest("Укажите и широту, и долготу");
  if (r.format === "OFFLINE" && r.lat == null) throw badRequest("Отметьте место на карте");
}

const textFields = (r: EventRequest) =>
  fields("Название", r.title, "Описание", r.description, "Вид спорта", r.sportName, "Адрес", r.address, "Как найти место", r.locationNote,
    "Требования", r.requirements, "Что взять с собой", r.equipment, "Детали для участников", r.privateDetails);

function submitForModeration(event: Row, now: number) {
  submitModeration(
    "EVENT", event.id, event.id, event.authorId,
    snapshotText(fields("Название", event.title, "Описание", event.description, "Как найти место", event.locationNote, "Требования", event.requirements,
      "Что взять с собой", event.equipment, "Детали для участников", event.privateDetails, "Объявление", event.announcement)),
    now,
  );
}

const blank = (v: unknown) => (v === undefined || v === "" ? null : v);

function formFields(r: EventRequest, sportId: string) {
  return {
    title: r.title, description: blank(r.description), sportId, format: r.format, address: blank(r.address), locationNote: blank(r.locationNote),
    onlineUrl: blank(r.onlineUrl), lat: r.format === "ONLINE" ? null : (r.lat ?? null), lon: r.format === "ONLINE" ? null : (r.lon ?? null),
    level: r.level ?? "ANY", kind: r.kind ?? null, requirements: blank(r.requirements), equipment: blank(r.equipment),
    capacity: r.capacity ?? null, joinMode: r.joinMode ?? "FREE", privateDetails: blank(r.privateDetails), minParticipants: r.minParticipants ?? null,
  };
}

export function createEvent(userId: string, r: EventRequest, now: number) {
  const user = db.users.get(userId);
  if (!user || !user.active) throw forbidden("Сессия недействительна, войдите заново");
  const organization = user.systemRole === "ORG" ? organizationOfAccount(userId) : undefined;
  const blocked = createBlockedReason(user, organization);
  if (blocked) throw forbidden(blocked);
  validate(r, now);
  requireClean(textFields(r));
  const plan = r.schedule ? expand(r.schedule) : null;
  const firstSlot = plan ? plan.slots.find((s) => s.start > now) : null;
  if (plan && !firstSlot) throw badRequest("В расписании нет ни одного будущего занятия");
  const sport = resolveSport(r.sportId, r.sportName, userId, now);
  const event = db.events.insert({
    id: newId(), ...formFields(r, sport.id as string), kind: r.kind ?? null, status: "PUBLISHED", authorId: userId,
    startAt: firstSlot ? firstSlot.start : parseInstant(r.startAt), endAt: firstSlot ? firstSlot.end : parseInstant(r.endAt),
    recurring: !!plan, timeZone: plan ? plan.zone : null, seriesStartDate: plan ? r.schedule.startDate : null,
    seriesEndDate: plan ? r.schedule.endDate : null, organizationId: organization?.id ?? null, createdAt: now, updatedAt: now,
    announcedAt: null, announcement: null, moderatedAt: null, moderatedById: null, moderationReason: null,
  });
  applyOccurrences(event, plan, now);
  submitForModeration(event, now);
  // «живой мир»: на встречу по заявке приходят заявки и вопрос
  if (event.joinMode === "REQUEST") schedule("event-applicants", 25_000, { eventId: event.id });
  if (organization) {
    const subscribers = db.organizationSubscriptions.rows.filter((s) => s.organizationId === organization.id).map((s) => s.userId as string);
    publish([{
      key: `org-new-event:${event.id}`, recipients: subscribers, actorId: userId, type: "ORG_NEW_EVENT", category: "ORGANIZATIONS",
      title: `Новая встреча: ${organization.name}`, body: event.title, targetPath: `/events/${event.id}`, eventId: event.id, organizationId: organization.id,
    }], now);
  }
  return getEvent(event.id as string, userId, now);
}

export function updateEvent(eventId: string, userId: string, r: EventRequest, now: number) {
  const event = requireEvent(eventId);
  if (!isOrganizer(event, userId)) throw forbidden("Редактировать мероприятие может только организатор");
  if (!canManage(event, userId)) throw conflict(manageConflictReason(event, "Мероприятие удалено, редактировать нельзя"));
  watch(eventId, userId);
  validate(r, now);
  requireClean(textFields(r));
  if (!!r.schedule !== !!event.recurring) {
    throw conflict(event.recurring ? "Повторяющееся мероприятие нельзя сделать разовым: создайте новое" : "Разовое мероприятие нельзя сделать повторяющимся: создайте новое");
  }
  const plan = r.schedule ? expand(r.schedule) : null;
  if (r.capacity != null) {
    if (event.recurring) {
      const attending = maxFutureAttendance(eventId, now);
      if (r.capacity < attending) throw conflict(`На одно из занятий уже отметились ${attending}, лимит мест не может быть меньше`);
    } else {
      const confirmedCount = db.registrations.rows.filter((x) => x.eventId === eventId && x.status === "CONFIRMED").length;
      if (r.capacity < confirmedCount) throw conflict(`Уже записано ${confirmedCount}, лимит мест не может быть меньше`);
    }
  }
  const sport = resolveSport(r.sportId, r.sportName, userId, now);
  Object.assign(event, formFields(r, sport.id as string), { updatedAt: now });
  if (plan) Object.assign(event, { timeZone: plan.zone, seriesStartDate: r.schedule.startDate, seriesEndDate: r.schedule.endDate });
  else Object.assign(event, { startAt: parseInstant(r.startAt), endAt: parseInstant(r.endAt) });
  db.events.touch();
  submitForModeration(event, now);
  applyOccurrences(event, plan, now);
  promoteWaitlist(event, now);
  return getEvent(eventId, userId, now);
}

function requireOrganizerManaged(eventId: string, userId: string, forbiddenText: string, deletedText: string): Row {
  const event = requireEvent(eventId);
  if (!isOrganizer(event, userId)) throw forbidden(forbiddenText);
  if (!canManage(event, userId)) throw conflict(manageConflictReason(event, deletedText));
  watch(eventId, userId);
  return event;
}

export function announce(eventId: string, userId: string, text: string, now: number) {
  const event = requireOrganizerManaged(eventId, userId, "Объявления публикует только организатор", "Мероприятие удалено, объявления недоступны");
  requireClean(fields("Объявление", text));
  Object.assign(event, { announcement: text, announcedAt: now, updatedAt: now });
  db.events.touch();
  submitForModeration(event, now);
  const recipients = new Set<string>(
    db.registrations.rows.filter((r) => r.eventId === eventId && ["CONFIRMED", "PENDING", "WAITLISTED"].includes(r.status)).map((r) => r.userId as string),
  );
  for (const id of organizerIds(event)) recipients.add(id);
  publish([{
    key: `announcement:${eventId}:${now}`, recipients, actorId: userId, type: "EVENT_ANNOUNCEMENT", category: "EVENTS",
    title: "Объявление организатора", body: `${event.title}\n${text}`, targetPath: `/events/${eventId}`, eventId,
  }], now);
  return getEvent(eventId, userId, now);
}

export function clearAnnouncement(eventId: string, userId: string, now: number) {
  const event = requireOrganizerManaged(eventId, userId, "Объявления снимает только организатор", "Мероприятие удалено, объявления недоступны");
  Object.assign(event, { announcement: null, announcedAt: null, updatedAt: now });
  db.events.touch();
  return getEvent(eventId, userId, now);
}

// ---------- фото ----------

function requireManageable(eventId: string, userId: string): Row {
  const event = requireEvent(eventId);
  if (!isOrganizer(event, userId)) throw forbidden("Менять фото может только организатор");
  if (!canManage(event, userId)) throw conflict(manageConflictReason(event, "Мероприятие удалено, менять фото нельзя"));
  watch(eventId, userId);
  return event;
}

const photoOf = (eventId: string, fileId: string): Row => {
  const f = requireFile(fileId);
  if (f.kind !== "EVENT_PHOTO" || f.eventId !== eventId) throw notFound("Файл не найден");
  return f;
};

export async function addPhoto(eventId: string, userId: string, form: FormData | null, query: Query, now: number) {
  requireManageable(eventId, userId);
  if (eventPhotosOf(eventId).length >= MAX_PHOTOS) throw conflict(`Можно загрузить не больше ${MAX_PHOTOS} фото`);
  const position = Math.max(-1, ...eventPhotosOf(eventId).map((f) => f.position ?? 0)) + 1;
  const photo = await storeUpload("EVENT_PHOTO", formFile(form), userId, null, eventId, position, now);
  const x = query.num("focusX");
  const y = query.num("focusY");
  if (x !== undefined || y !== undefined) setFocus(photo, { x, y });
  return getEvent(eventId, userId, now);
}

export function setPhotoFocus(eventId: string, fileId: string, userId: string, focus: { x?: number; y?: number } | null, now: number) {
  requireManageable(eventId, userId);
  setFocus(photoOf(eventId, fileId), focus);
  return getEvent(eventId, userId, now);
}

export function removePhoto(eventId: string, fileId: string, userId: string, now: number) {
  requireManageable(eventId, userId);
  deleteFile(photoOf(eventId, fileId));
  return getEvent(eventId, userId, now);
}

// ---------- календарь ----------

const escapeIcs = (t: string) => t.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Строки длиннее 75 байт переносятся (CRLF + пробел), не разрывая символ. */
function foldLine(content: string): string {
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of content) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      out += "\r\n ";
      bytes = 0;
      limit = 74;
    }
    out += ch;
    bytes += size;
  }
  return `${out}\r\n`;
}

export function calendarIcs(eventId: string, userId: string, now: number): string {
  const event = requireEvent(eventId);
  const mine = registrationOf(eventId, userId);
  const privateDetails = canSeePrivateDetails(event, userId, mine);
  const scheduled = calendarOccurrences(event, userId, now);
  const location = event.format === "ONLINE" ? "Онлайн" : event.address;
  const parts: string[] = [];
  if ((event.description ?? "").trim()) parts.push(event.description);
  const add = (label: string, value: unknown) => {
    if (String(value ?? "").trim()) parts.push(`${label}: ${value}`);
  };
  add("Что взять", event.equipment);
  add("Требования", event.requirements);
  add("Как найти место", event.locationNote);
  if (privateDetails) {
    add("Для участников", event.privateDetails);
    add("Ссылка", event.onlineUrl);
  }
  const description = parts.join("\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sport Together//Events//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const o of scheduled) {
    lines.push("BEGIN:VEVENT", `UID:${o.id}@sport-together`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(o.startAt)}`);
    if (o.endAt != null) lines.push(`DTEND:${icsDate(o.endAt)}`);
    lines.push(`SUMMARY:${escapeIcs(event.title)}`);
    if (location) lines.push(`LOCATION:${escapeIcs(location)}`);
    if (description) lines.push(`DESCRIPTION:${escapeIcs(description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("");
}
