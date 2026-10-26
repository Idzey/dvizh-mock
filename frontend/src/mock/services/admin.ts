// Админка: дашборд, мероприятия, пользователи, очередь модерации, справочник видов спорта, вещи бобра
// (порт AdminEventService, AdminUserService, AdminModerationService, AdminSportService, AdminPetService).
import { db, type Row } from "../db";
import { badRequest, conflict, notFound, notImplemented } from "../http";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { addDays, dateKey, startOfDay, ZONE } from "../util/time";
import { watch } from "./changes";
import { hideComment } from "./comments";
import { iso, sportHasOwnImage, sportImageFocus, sportImageUrl, sportResponse, userShort } from "./common";
import { deleteFile, formFile, storeUpload } from "./files";
import { resolve as resolveModeration } from "./moderation";
import { collapseSpaces, freeSlug, normalizeSport } from "./sports";
import { restoreBlockedReason, unpublishBlockedReason } from "./policy";
import { EVENT_NOT_FOUND } from "./occurrences";

const page = <T>(all: T[], p: number, size: number) => {
  const s = Math.min(Math.max(size, 1), 100);
  const index = Math.max(p, 0);
  return { rows: all.slice(index * s, index * s + s), page: index, size: s, totalElements: all.length, totalPages: Math.ceil(all.length / s) };
};

// ---------- мероприятия и дашборд ----------

function adminEvent(event: Row) {
  return {
    id: event.id,
    title: event.title,
    sport: sportResponse(db.sports.get(event.sportId) as Row),
    startAt: iso(event.startAt),
    address: event.address ?? null,
    author: userShort(db.users.get(event.authorId)),
    organizationId: event.organizationId ?? null,
    participantsCount: db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "CONFIRMED").length,
    status: event.status,
    moderationReason: event.moderationReason ?? null,
    moderatedAt: iso(event.moderatedAt),
    createdAt: iso(event.createdAt),
  };
}

export function adminListEvents(status: string | undefined, organizationId: string | undefined, authorId: string | undefined, searchText: string | undefined, p: number, size: number) {
  const q = (searchText ?? "").trim().toLowerCase();
  const found = db.events.rows
    .filter((e) => (!status || e.status === status) && (!organizationId || e.organizationId === organizationId) && (!authorId || e.authorId === authorId))
    .filter((e) => String(e.title).toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
  const { rows, ...meta } = page(found, p, size);
  return { items: rows.map(adminEvent), ...meta };
}

function moderateEvent(event: Row, status: string, reason: string | null, adminId: string, now: number) {
  Object.assign(event, { status, moderationReason: reason, moderatedAt: now, moderatedById: adminId, updatedAt: now });
  db.events.touch();
  if (status !== "PUBLISHED") resolveModeration("EVENT", event.id as string, "ACTION_TAKEN", adminId, now);
  return adminEvent(event);
}

const lockedEvent = (id: string): Row => {
  const e = db.events.get(id);
  if (!e) throw notFound(EVENT_NOT_FOUND);
  return e;
};

export function adminUnpublish(id: string, adminId: string, reason: string, now: number) {
  const event = lockedEvent(id);
  watch(id, adminId);
  const blocked = unpublishBlockedReason(event);
  if (blocked) throw conflict(blocked);
  return moderateEvent(event, "UNPUBLISHED", reason, adminId, now);
}

export function adminRestore(id: string, adminId: string, now: number) {
  const event = lockedEvent(id);
  watch(id, adminId);
  const blocked = restoreBlockedReason(event);
  if (blocked) throw conflict(blocked);
  return moderateEvent(event, "PUBLISHED", null, adminId, now);
}

export function adminDelete(id: string, adminId: string, reason: string, now: number) {
  const event = lockedEvent(id);
  watch(id, adminId);
  return moderateEvent(event, "DELETED", reason, adminId, now);
}

export function adminStats(days: number, now: number) {
  const period = Math.min(Math.max(days, 1), 366);
  const today = startOfDay(now, ZONE);
  const first = addDays(today, -(period - 1), ZONE);
  const byDate = new Map<string, number>();
  for (const u of db.users.rows) if (u.createdAt >= first) byDate.set(dateKey(u.createdAt, ZONE), (byDate.get(dateKey(u.createdAt, ZONE)) ?? 0) + 1);
  const signupsByDay = [];
  for (let i = 0; i < period; i++) {
    const date = dateKey(addDays(first, i, ZONE), ZONE);
    signupsByDay.push({ date, count: byDate.get(date) ?? 0 });
  }
  const count = (rows: Row[], key: string, value: string) => rows.filter((r) => r[key] === value).length;
  return {
    users: db.users.rows.length,
    organizationsPending: count(db.organizations.rows, "status", "PENDING"),
    organizationsApproved: count(db.organizations.rows, "status", "APPROVED"),
    eventsPublished: count(db.events.rows, "status", "PUBLISHED"),
    eventsUnpublished: count(db.events.rows, "status", "UNPUBLISHED"),
    eventsDeleted: count(db.events.rows, "status", "DELETED"),
    registrationsConfirmed: count(db.registrations.rows, "status", "CONFIRMED"),
    registrationsPending: count(db.registrations.rows, "status", "PENDING"),
    comments: db.comments.rows.length,
    moderationQueue: db.moderationChecks.rows.filter((c) => c.status === "FLAGGED" || c.status === "AUTO_HIDDEN").length,
    signupsByDay,
  };
}

export function adminListUsers(searchText: string | undefined, role: string | undefined, p: number, size: number) {
  const q = (searchText ?? "").trim().toLowerCase();
  const found = db.users.rows
    .filter((u) => !role || u.systemRole === role)
    .filter((u) => [u.username, u.email, u.firstName, u.lastName].some((f) => String(f ?? "").toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const { rows, ...meta } = page(found, p, size);
  const authored = new Map<string, number>();
  for (const e of db.events.rows) authored.set(e.authorId, (authored.get(e.authorId) ?? 0) + 1);
  const confirmed = new Map<string, number>();
  for (const r of db.registrations.rows) if (r.status === "CONFIRMED") confirmed.set(r.userId, (confirmed.get(r.userId) ?? 0) + 1);
  return {
    items: rows.map((u) => ({
      id: u.id, username: u.username, email: u.email, firstName: u.firstName, lastName: u.lastName, systemRole: u.systemRole, active: u.active,
      city: u.city ?? null, createdAt: iso(u.createdAt), eventsCount: authored.get(u.id) ?? 0, registrationsCount: confirmed.get(u.id) ?? 0,
    })),
    ...meta,
  };
}

// ---------- очередь модерации текстов ----------

const CHECK_NOT_FOUND = "Проверка не найдена";
const QUEUE = ["FLAGGED", "AUTO_HIDDEN"];

function moderationItem(check: Row) {
  const nameOf = (u: Row | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);
  let title: string | null = null;
  switch (check.targetType) {
    case "COMMENT":
    case "EVENT":
      title = (check.eventId && db.events.get(check.eventId)?.title) || null;
      break;
    case "ORGANIZATION":
      title = db.organizations.get(check.targetId)?.name ?? null;
      break;
    default:
      title = nameOf(db.users.get(check.targetId));
  }
  const comment = check.targetType === "COMMENT" ? db.comments.get(check.targetId) : undefined;
  return {
    id: check.id,
    targetType: check.targetType,
    targetId: check.targetId,
    eventId: check.eventId ?? null,
    targetTitle: title,
    author: userShort(check.authorId ? db.users.get(check.authorId) : null),
    text: check.textSnapshot ?? "",
    status: check.status,
    source: check.source ?? null,
    categories: check.categories ?? [],
    severity: check.severity ?? 0,
    explanation: check.explanation ?? null,
    hidden: !!comment?.hidden,
    updatedAt: iso(check.updatedAt),
    checkedAt: iso(check.checkedAt),
    decision: check.decision ?? null,
    reviewedAt: iso(check.reviewedAt),
  };
}

export function adminListModeration(status: string | undefined, targetType: string | undefined, p: number, size: number) {
  const statuses = status ? [status] : QUEUE;
  const found = db.moderationChecks.rows
    .filter((c) => statuses.includes(c.status) && (!targetType || c.targetType === targetType))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const { rows, ...meta } = page(found, p, size);
  return { items: rows.map(moderationItem), ...meta };
}

const findCheck = (id: string): Row => {
  const c = db.moderationChecks.get(id);
  if (!c) throw notFound(CHECK_NOT_FOUND);
  return c;
};

function review(check: Row, decision: string, adminId: string, now: number) {
  Object.assign(check, { status: "RESOLVED", decision, reviewedAt: now, reviewedById: adminId, updatedAt: now });
  db.moderationChecks.touch();
}

/** «Всё в порядке»: флаг снимается; автоматически скрытое сообщение возвращается в поток. */
export function approveModeration(id: string, adminId: string, now: number) {
  const check = findCheck(id);
  if (check.targetType === "COMMENT") {
    const comment = db.comments.get(check.targetId);
    if (comment && comment.hidden && !comment.hiddenById) {
      Object.assign(comment, { hidden: false, hiddenAt: null, hiddenById: null, hideReason: null, updatedAt: now });
      db.comments.touch();
    }
  }
  review(check, "APPROVED", adminId, now);
  return moderationItem(check);
}

export function hideModeration(id: string, adminId: string, reason: string, now: number) {
  const check = findCheck(id);
  if (check.targetType !== "COMMENT") throw conflict("Скрыть можно только сообщение. Мероприятие снимите с публикации, анкету верните на доработку");
  hideComment(check.targetId, adminId, reason, now);
  if (check.status !== "RESOLVED") review(check, "HIDDEN", adminId, now);
  return moderationItem(check);
}

export function clearProfileText(id: string, adminId: string, now: number) {
  const check = findCheck(id);
  if (check.targetType !== "USER_PROFILE") throw conflict("Очистить можно только текст профиля");
  const user = db.users.get(check.targetId);
  if (!user) throw notFound("Пользователь не найден");
  user.bio = null;
  db.users.touch();
  review(check, "ACTION_TAKEN", adminId, now);
  return moderationItem(check);
}

export function recheckModeration(): never {
  throw conflict("В демо-версии нейросеть модерации отключена: тексты проверяет словарь");
}

// ---------- справочник видов спорта ----------

const SPORT_NOT_FOUND = "Вид спорта не найден";
const SPORT_IMAGE_MAX = 2 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const hasImage = (s: Row) => !!s.imageFileId || sportHasOwnImage(s.slug);
const findSport = (id: string): Row => {
  const s = db.sports.get(id);
  if (!s) throw notFound(SPORT_NOT_FOUND);
  return s;
};

function sportEventCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of db.events.rows) counts.set(e.sportId, (counts.get(e.sportId) ?? 0) + 1);
  return counts;
}

function adminSport(s: Row, counts: Map<string, number> = sportEventCounts()) {
  const proposer = s.custom && s.createdById ? db.users.get(s.createdById) : undefined;
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    custom: s.custom,
    status: s.catalogStatus,
    hasImage: hasImage(s),
    imageUploaded: !!s.imageFileId,
    imageUrl: hasImage(s) ? sportImageUrl(s) : null,
    imageFocus: sportImageFocus(s),
    eventsCount: counts.get(s.id as string) ?? 0,
    proposedBy: proposer ? userShort(proposer) : null,
    moderationReason: s.decisionReason ?? null,
    mergedIntoName: s.mergedIntoId ? (db.sports.get(s.mergedIntoId)?.name ?? null) : null,
    moderatedAt: iso(s.decidedAt),
    createdAt: iso(s.createdAt),
  };
}

export function adminListSports(statuses: string[], withoutImage: boolean | undefined, searchText: string | undefined, p: number, size: number) {
  const query = normalizeSport(searchText);
  const found = db.sports.rows
    .filter((s) => !statuses.length || statuses.includes(s.catalogStatus))
    .filter((s) => !withoutImage || !hasImage(s))
    .filter((s) => !query || String(s.normalizedName).includes(query))
    .sort((a, b) => cmp(String(a.normalizedName), String(b.normalizedName)));
  const { rows, ...meta } = page(found, p, size);
  const counts = sportEventCounts();
  return { items: rows.map((s) => adminSport(s, counts)), ...meta };
}

export function adminSportCounts() {
  const all = db.sports.rows;
  const n = (status: string) => all.filter((s) => s.catalogStatus === status).length;
  return { all: all.length, catalog: n("ACTIVE"), pending: n("PENDING"), hidden: n("HIDDEN") + n("MERGED"), withoutImage: all.filter((s) => !hasImage(s)).length };
}

function validatePng(bytes: Uint8Array, size: number) {
  if (!size) throw badRequest("Файл пустой");
  if (bytes.length < 8 || PNG.some((b, i) => bytes[i] !== b)) throw badRequest("Картинка вида должна быть в формате PNG");
  if (size > SPORT_IMAGE_MAX) throw badRequest("Файл слишком большой: максимум 2 МБ");
}

async function checkSquare(file: File) {
  // размер из заголовка PNG: ширина и высота лежат в IHDR со смещения 16
  const header = new DataView(await file.slice(0, 24).arrayBuffer());
  const w = header.getUint32(16);
  const h = header.getUint32(20);
  if (w !== h || w < 256) throw badRequest("Картинка должна быть квадратной, не меньше 256×256 пикселей");
}

async function attachImage(sport: Row, adminId: string, file: File, focus: { x?: number; y?: number } | null, now: number) {
  validatePng(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.size);
  await checkSquare(file);
  const stored = await storeUpload("SPORT_IMAGE", file, adminId, null, null, null, now);
  const previous = sport.imageFileId ? db.files.get(sport.imageFileId) : undefined;
  Object.assign(sport, { imageFileId: stored.id, imageFocusX: focus?.x ?? null, imageFocusY: focus?.y ?? null });
  db.sports.touch();
  if (previous) deleteFile(previous);
}

function detachImage(sport: Row) {
  const previous = sport.imageFileId ? db.files.get(sport.imageFileId) : undefined;
  Object.assign(sport, { imageFileId: null, imageFocusX: null, imageFocusY: null });
  db.sports.touch();
  if (previous) deleteFile(previous);
}

function decideSport(sport: Row, status: string, reason: string | null, mergedIntoId: string | null, adminId: string, now: number) {
  Object.assign(sport, { catalogStatus: status, decisionReason: reason, mergedIntoId, decidedAt: now, decidedById: adminId, updatedAt: now });
  db.sports.touch();
  return adminSport(sport);
}

export async function adminCreateSport(adminId: string, name: string, form: FormData | null, focusX: number | undefined, focusY: number | undefined, published: boolean, now: number) {
  const display = collapseSpaces(name);
  if (!display) throw badRequest("Введите название вида спорта");
  if (display.length > 100) throw badRequest("Название слишком длинное: максимум 100 символов");
  const normalized = normalizeSport(display) as string;
  const existing = db.sports.find((s) => s.normalizedName === normalized);
  if (existing) throw conflict(`Вид «${existing.name}» уже есть в справочнике`);
  // как транзакция бэкенда: плохая картинка не оставляет вид в справочнике
  const file = form?.get("file");
  if (file instanceof Blob) {
    validatePng(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.size);
    await checkSquare(file as File);
  }
  const sport = db.sports.insert({
    id: newId(), name: display, slug: freeSlug(normalized.replaceAll(" ", "-")), custom: false, createdAt: now, decidedAt: null, updatedAt: now,
    createdById: adminId, decidedById: null, imageFileId: null, imageFocusX: null, imageFocusY: null, mergedIntoId: null,
    catalogStatus: published ? "ACTIVE" : "HIDDEN", decisionReason: null, normalizedName: normalized,
  });
  if (file instanceof Blob) await attachImage(sport, adminId, file as File, focusX != null || focusY != null ? { x: focusX, y: focusY } : null, now);
  return adminSport(sport);
}

export function adminRenameSport(id: string, name: string) {
  const sport = findSport(id);
  const display = collapseSpaces(name);
  if (!display) throw badRequest("Введите название вида спорта");
  const normalized = normalizeSport(display) as string;
  const other = db.sports.find((s) => s.normalizedName === normalized && s.id !== id);
  if (other) throw conflict(`Вид «${other.name}» уже есть в справочнике`);
  Object.assign(sport, { name: display, normalizedName: normalized });
  db.sports.touch();
  return adminSport(sport);
}

export async function adminReplaceSportImage(id: string, adminId: string, form: FormData | null, focusX: number | undefined, focusY: number | undefined, now: number) {
  const sport = findSport(id);
  await attachImage(sport, adminId, formFile(form), focusX != null || focusY != null ? { x: focusX, y: focusY } : null, now);
  return adminSport(sport);
}

export function adminRemoveSportImage(id: string) {
  const sport = findSport(id);
  detachImage(sport);
  return adminSport(sport);
}

export function adminApproveSport(id: string, adminId: string, now: number) {
  const sport = findSport(id);
  if (sport.catalogStatus !== "PENDING") throw conflict(`Вид «${sport.name}» не ждёт проверки`);
  return decideSport(sport, "ACTIVE", null, null, adminId, now);
}

export function adminHideSport(id: string, adminId: string, reason: string | undefined, now: number) {
  const sport = findSport(id);
  if (sport.catalogStatus === "HIDDEN" || sport.catalogStatus === "MERGED") throw conflict(`Вид «${sport.name}» уже отключён`);
  return decideSport(sport, "HIDDEN", reason && reason.trim() ? reason.trim() : null, null, adminId, now);
}

export function adminRestoreSport(id: string, adminId: string, now: number) {
  const sport = findSport(id);
  if (sport.catalogStatus !== "HIDDEN") throw conflict(`Вид «${sport.name}» не отключён`);
  return decideSport(sport, "ACTIVE", null, null, adminId, now);
}

function reassignSport(from: string, to: string) {
  db.userSports.removeWhere((us) => us.sportId === from && db.userSports.rows.some((t) => t.userId === us.userId && t.sportId === to));
  db.organizationSports.removeWhere((os) => os.sportId === from && db.organizationSports.rows.some((t) => t.organizationId === os.organizationId && t.sportId === to));
  for (const table of [db.events, db.userSports, db.organizationSports, db.recommendationDismissals]) {
    for (const row of table.rows) if (row.sportId === from) row.sportId = to;
    table.touch();
  }
  for (const s of db.sports.rows) if (s.mergedIntoId === from) s.mergedIntoId = to;
}

export function adminMergeSport(id: string, targetId: string, reason: string | undefined, adminId: string, now: number) {
  const sport = findSport(id);
  if (id === targetId) throw badRequest("Нельзя объединить вид с самим собой");
  const target = db.sports.get(targetId);
  if (!target) throw badRequest("Целевой вид не найден");
  if (sport.catalogStatus === "MERGED") throw conflict(`Вид «${sport.name}» уже объединён`);
  if (target.catalogStatus !== "ACTIVE" && target.catalogStatus !== "PENDING") throw conflict(`Нельзя объединять с отключённым видом «${target.name}»`);
  reassignSport(id, targetId);
  const why = reason && reason.trim() ? reason.trim() : null;
  return decideSport(sport, "MERGED", why ?? `Дубликат вида «${target.name}»`, targetId, adminId, now);
}

export function adminDeleteSport(id: string) {
  const sport = findSport(id);
  const usages =
    db.events.rows.filter((e) => e.sportId === id).length + db.userSports.rows.filter((u) => u.sportId === id).length +
    db.organizationSports.rows.filter((o) => o.sportId === id).length + db.recommendationDismissals.rows.filter((d) => d.sportId === id).length +
    db.sports.rows.filter((s) => s.mergedIntoId === id).length;
  if (usages > 0) throw conflict(`Вид «${sport.name}» используется: скройте его или объедините с другим`);
  detachImage(sport);
  db.sports.remove(id);
}

// ---------- вещи бобра ----------

const customItem = (code: string): Row => {
  const item = db.petItems.find((i) => i.code === code && !i.builtIn);
  if (!item) throw notFound(`Вещь «${code}» не найдена`);
  return item;
};

function petItemResponse(item: Row) {
  return {
    id: item.code,
    label: item.label,
    builtIn: item.builtIn,
    art: item.svg == null ? null : { bodyPart: item.bodyPart, svg: item.svg, x: item.fitX, y: item.fitY, scale: item.fitScale },
  };
}

export const adminListPetItems = () => db.petItems.rows.filter((i) => !i.builtIn).sort((a, b) => b.createdAt - a.createdAt).map(petItemResponse);

export function adminUpdatePetItemFit(code: string, fit: { x: number; y: number; scale: number }) {
  const item = customItem(code);
  if (fit.x < -500 || fit.x > 1000 || fit.y < -500 || fit.y > 1000 || fit.scale < 0.01 || fit.scale > 20) {
    throw badRequest("Посадка вне рисунка: x и y от −500 до 1000, масштаб от 0.01 до 20");
  }
  Object.assign(item, { fitX: fit.x, fitY: fit.y, fitScale: fit.scale });
  db.petItems.touch();
  return petItemResponse(item);
}

export function adminDeletePetItem(code: string) {
  const item = customItem(code);
  db.userPetEquipment.removeWhere((e) => e.itemId === item.id);
  db.petItems.remove(item.id as string);
}

/** Импорт рисунка вещи в бэкенде делает Python-скрипт; в браузерной демо-версии его нет. */
export function adminImportPetItem(): never {
  throw notImplemented("В демо-версии загрузка новых вещей для бобра недоступна");
}

