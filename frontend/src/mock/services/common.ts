// Общие кирпичики ответов: файлы, виды спорта, краткие карточки людей и организаций.
import { db, meta, type Row } from "../db";

export const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const fileUrl = (id: string | null | undefined): string | null => (id ? `/api/files/${id}` : null);

export type Focus = { x: number; y: number };

export function fileFocus(file: Row): Focus | null {
  return file.focusX == null || file.focusY == null ? null : { x: file.focusX, y: file.focusY };
}

export function fileResponse(file: Row) {
  return {
    id: file.id,
    url: fileUrl(file.id),
    name: file.originalName,
    contentType: file.contentType,
    size: file.sizeBytes,
    focus: fileFocus(file),
  };
}

/** Где на иллюстрации голова персонажа (% ширины, % высоты): превью обрезаются вокруг неё. Замерено бэкендом. */
const SPORT_FOCUS: Record<string, Focus> = {
  badminton: { x: 42, y: 25 }, basketball: { x: 55, y: 16 }, boxing: { x: 52, y: 12 }, checkers: { x: 53, y: 19 },
  chess: { x: 55, y: 20 }, climbing: { x: 47, y: 20 }, cycling: { x: 52, y: 15 }, dance: { x: 47, y: 18 },
  default: { x: 50, y: 20 }, drone_racing: { x: 45, y: 18 }, esports: { x: 48, y: 27 }, fitness: { x: 50, y: 15 },
  football: { x: 47, y: 15 }, hockey: { x: 55, y: 17 }, martial_arts: { x: 50, y: 12 }, nordic_walking: { x: 53, y: 16 },
  paralympic: { x: 58, y: 27 }, robotics: { x: 55, y: 22 }, running: { x: 55, y: 16 }, skating: { x: 62, y: 14 },
  skiing: { x: 58, y: 16 }, sport_programming: { x: 43, y: 21 }, swimming: { x: 73, y: 50 }, table_tennis: { x: 45, y: 16 },
  tennis: { x: 55, y: 21 }, volleyball: { x: 50, y: 38 }, workout: { x: 48, y: 12 }, yoga: { x: 50, y: 12 },
  "зарядка": { x: 50, y: 22 }, "петанк": { x: 53, y: 17 },
};

const sportKey = (slug: string | null | undefined) => (slug && meta.sportImages[slug] ? slug : "default");
export const sportHasOwnImage = (slug: string | null | undefined) => sportKey(slug) !== "default";

export function sportImageUrl(sport: Row): string {
  if (sport.imageFileId) return fileUrl(sport.imageFileId) as string;
  return `/media/sport-images/${meta.sportImages[sportKey(sport.slug)] ?? "default.webp"}`;
}

export function sportImageFocus(sport: Row): Focus {
  if (!sport.imageFileId) return SPORT_FOCUS[sportKey(sport.slug)] ?? SPORT_FOCUS.default;
  return sport.imageFocusX == null || sport.imageFocusY == null
    ? SPORT_FOCUS.default
    : { x: sport.imageFocusX, y: sport.imageFocusY };
}

export function sportResponse(sport: Row) {
  return {
    id: sport.id,
    name: sport.name,
    slug: sport.slug,
    custom: sport.custom,
    imageUrl: sportImageUrl(sport),
    imageFocus: sportImageFocus(sport),
  };
}

export function userShort(user: Row | undefined | null) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl ?? null,
    city: user.city ?? null,
  };
}

export function orgShort(org: Row | undefined | null) {
  if (!org) return null;
  return { id: org.id, name: org.name, status: org.status };
}

/** Нормализованное название для поиска: нижний регистр, «ё» = «е», без лишних пробелов и знаков. */
export const normalizeName = (name: string) =>
  name
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Слаг для своих видов спорта: нормализованное название через дефис (кириллица сохраняется). */
export const slugOf = (name: string) => normalizeName(name).replaceAll(" ", "-");

export const byCreatedAtDesc = (a: Row, b: Row) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id));
export const byCreatedAtAsc = (a: Row, b: Row) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id));

/** Организация, которой управляет аккаунт. */
export const organizationOfAccount = (userId: string): Row | undefined =>
  db.organizations.find((o) => o.accountId === userId);
