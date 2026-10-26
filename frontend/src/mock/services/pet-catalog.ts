// Каталог бобра (слоты и вещи) и инвентарь пользователя. Сами слоты и вещи лежат в снапшоте; здесь — выборки и владение.
import { db, type Row } from "../db";
import { notFound } from "../http";
import { newId } from "../util/ids";

export const ACTIVITY = "activity";
export const NO_ACTIVITY = "none";

/** Последняя волна каталога: новые виды экипировки (бейдж «новое»). */
const NEW_CODES = new Set([
  "cyclehelmet", "roundglasses", "scarf", "bowtie", "shorts", "leggings", "sweatpants", "basketball", "volleyball",
  "polo", "hoodie", "tracksuit", "puffer", "racket", "paddle", "yogamat", "boxinggloves", "wristbands", "sneakers",
]);
export const isNewItem = (code: string) => NEW_CODES.has(code);

export type Catalog = {
  slots: Row[];
  itemsBySlot: Map<string, Row[]>;
  itemsById: Map<string, Row>;
  slot(code: string): Row | undefined;
  item(slot: Row, code: string): Row | undefined;
};

const byPosition = (a: Row, b: Row) => (a.position ?? 0) - (b.position ?? 0);

export function loadCatalog(): Catalog {
  const slots = [...db.petSlots.rows].sort(byPosition);
  const itemsBySlot = new Map<string, Row[]>();
  const itemsById = new Map<string, Row>();
  for (const item of [...db.petItems.rows].sort(byPosition)) {
    itemsById.set(item.id as string, item);
    const list = itemsBySlot.get(item.slotId) ?? [];
    list.push(item);
    itemsBySlot.set(item.slotId, list);
  }
  return {
    slots,
    itemsBySlot,
    itemsById,
    slot: (code) => slots.find((s) => s.code === code),
    item: (slot, code) => itemsBySlot.get(slot.id as string)?.find((i) => i.code === code),
  };
}

/** Найти вещь по id «слот:код»; нет — 404. */
export function findItem(catalog: Catalog, id: string): Row {
  const [slotCode, ...rest] = id.split(":");
  const slot = rest.length ? catalog.slot(slotCode) : undefined;
  const item = slot ? catalog.item(slot, rest.join(":")) : undefined;
  if (!item) throw notFound(`Вещь «${id}» не найдена`);
  return item;
}

/** Id вещей пользователя: базовые у всех плюс инвентарь. */
export function ownedIds(userId: string, catalog: Catalog = loadCatalog()): Set<string> {
  const owned = new Set<string>();
  for (const row of db.userItems.rows) if (row.userId === userId) owned.add(row.itemId);
  for (const item of catalog.itemsById.values()) if (item.kind === "BASE") owned.add(item.id as string);
  return owned;
}

export function owns(userId: string, id: string): boolean {
  const catalog = loadCatalog();
  return ownedIds(userId, catalog).has(findItem(catalog, id).id as string);
}

export const itemLabel = (id: string) => findItem(loadCatalog(), id).label as string;

/** Выдать вещь (награда за достижение); повтор ничего не меняет. */
export function grantItem(userId: string, id: string) {
  const item = findItem(loadCatalog(), id);
  if (db.userItems.rows.some((r) => r.userId === userId && r.itemId === item.id)) return;
  const now = Date.now();
  db.userItems.insert({ id: newId(), itemId: item.id, userId, createdAt: now, updatedAt: now });
}

export function addItemToInventory(userId: string, itemId: string) {
  const now = Date.now();
  db.userItems.insert({ id: newId(), itemId, userId, createdAt: now, updatedAt: now });
}
