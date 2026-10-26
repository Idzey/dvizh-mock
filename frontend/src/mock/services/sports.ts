// Справочник видов спорта (порт SportService): поиск, в том числе с опечатками, и создание своего вида из формы.
import { db, type Row } from "../db";
import { badRequest } from "../http";
import { newId } from "../util/ids";
import { cmp } from "../util/text";
import { sportResponse } from "./common";

const SIMILAR_LIMIT = 5;
const TRIGRAM_THRESHOLD = 0.3;

/** Ключ без дублей: схлопнуть пробелы, нижний регистр, ё → е. */
export const collapseSpaces = (value: string | null | undefined) => {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.replace(/\s+/gu, " ") : null;
};
export const normalizeSport = (value: string | null | undefined) => {
  const collapsed = collapseSpaces(value);
  return collapsed ? collapsed.toLowerCase().replaceAll("ё", "е") : null;
};

export const selectable = (sport: Row) => sport.catalogStatus === "ACTIVE" || sport.catalogStatus === "PENDING";

const trigrams = (text: string) => {
  const padded = `  ${text} `;
  const set = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  return set;
};

/** Похожесть как у pg_trgm: доля общих триграмм. */
function similarity(a: string, b: string) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}

const byName = (a: Row, b: Row) => cmp(String(a.name), String(b.name));

/** Пустой запрос — весь справочник; иначе подстрока и похожие с опечаткой («падэл» → «Падел»). */
export function searchSports(query: string | undefined) {
  const normalized = normalizeSport(query);
  const all = db.sports.rows;
  if (!normalized) return all.filter(selectable).sort(byName).map(sportResponse);
  const exact = all.filter((s) => String(s.normalizedName).includes(normalized) && selectable(s)).sort(byName);
  const similar = all
    .filter((s) => selectable(s) && !exact.includes(s))
    .map((s) => ({ s, score: similarity(normalized, String(s.normalizedName)) }))
    .filter((x) => x.score >= TRIGRAM_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, SIMILAR_LIMIT)
    .map((x) => x.s);
  return [...exact, ...similar].map(sportResponse);
}

/** Отключённый вид выбрать нельзя; слитый заменяется видом, с которым его объединили. */
function usable(sport: Row): Row {
  switch (sport.catalogStatus) {
    case "MERGED": {
      const target = db.sports.get(sport.mergedIntoId);
      if (!target) throw badRequest("Неизвестный вид спорта");
      return usable(target);
    }
    case "HIDDEN":
      throw badRequest(`Вид спорта «${sport.name}» отключён администратором`);
    default:
      return sport;
  }
}

/** Свободный slug: при совпадении добавляется номер — «мини-футбол-2». */
export function freeSlug(name: string) {
  const base = name.length > 95 ? name.slice(0, 95) : name;
  let slug = base;
  for (let n = 2; db.sports.rows.some((s) => s.slug === slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** Вид спорта для формы: из справочника по id или свой по названию (создаётся и ждёт проверки админа). */
export function resolveSport(sportId: string | null | undefined, sportName: string | null | undefined, userId: string, now = Date.now()): Row {
  const name = collapseSpaces(sportName);
  if (!sportId === !name) throw badRequest("Выберите вид спорта из списка или введите свой");
  if (sportId) {
    const sport = db.sports.get(sportId);
    if (!sport) throw badRequest("Неизвестный вид спорта");
    return usable(sport);
  }
  const normalized = normalizeSport(name) as string;
  const existing = db.sports.find((s) => s.normalizedName === normalized);
  if (existing) return usable(existing);
  return db.sports.insert({
    id: newId(), name, slug: freeSlug(normalized.replaceAll(" ", "-")), custom: true, createdAt: now, decidedAt: null,
    updatedAt: now, createdById: userId, decidedById: null, imageFileId: null, imageFocusX: null, imageFocusY: null,
    mergedIntoId: null, catalogStatus: "PENDING", decisionReason: null, normalizedName: normalized,
  });
}

/** Для ленты «Для меня»: вид спорта → уровень мероприятия, который подходит; null — любой уровень. */
export function sportPreferences(userId: string): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const us of db.userSports.rows) if (us.userId === userId) result.set(us.sportId, us.level ?? null);
  return result;
}
