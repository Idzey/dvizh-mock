// Бобр: образ, настроение, магазин, комплекты и сохранённые образы
// (порт PetService, PetMoodService, ShopService, PetBundleService, PetSavedLookService).
import { db, meta, type Row } from "../db";
import { badRequest, conflict, notFound } from "../http";
import { newId } from "../util/ids";
import { DAY, HOUR, dateText, partsIn, timeText, ZONE } from "../util/time";
import { ACHIEVEMENTS, applyCoins, requireUserAccount, type AchievementCode } from "./economy";
import {
  ACTIVITY, NO_ACTIVITY, addItemToInventory, findItem, isNewItem, loadCatalog, ownedIds, owns, type Catalog,
} from "./pet-catalog";

const DEFAULT_PET_NAME = "Бублик";
const MAX_LOOKS = 4;

// ---------- образ ----------

export function petLook(user: Row, catalog: Catalog, equipment: Row[]) {
  const equippedBySlot = new Map<string, Row>();
  for (const e of equipment) {
    const item = catalog.itemsById.get(e.itemId);
    if (item) equippedBySlot.set(e.slotId, item);
  }
  let activity = "none";
  const outfit: Record<string, string> = {};
  for (const slot of catalog.slots) {
    const item = equippedBySlot.get(slot.id as string);
    if (!item) continue;
    if (slot.kind === "ACTIVITY") activity = item.code;
    else outfit[slot.code] = item.code;
  }
  return { name: user.petName ?? DEFAULT_PET_NAME, activity, outfit };
}

const equipmentOf = (userId: string) => db.userPetEquipment.rows.filter((e) => e.userId === userId);

/** Образы участников для карточек: каталог общий, надетое группируется один раз. */
export function participants(users: Row[]) {
  if (!users.length) return [];
  const catalog = loadCatalog();
  const wanted = new Set(users.map((u) => u.id as string));
  const byUser = new Map<string, Row[]>();
  for (const e of db.userPetEquipment.rows) {
    if (!wanted.has(e.userId)) continue;
    const list = byUser.get(e.userId) ?? [];
    list.push(e);
    byUser.set(e.userId, list);
  }
  return users.map((user) => ({
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl ?? null,
    city: user.city ?? null,
    pet: petLook(user, catalog, byUser.get(user.id as string) ?? []),
  }));
}

// ---------- настроение ----------

type Mood = "idle" | "happy" | "wink" | "sad" | "offended" | "surprised" | "thinking" | "sleep";
type Status = { mood: Mood; message: string; reason: string; eventId: string | null; eventTitle: string | null };

const state = (mood: Mood, message: string, reason: string, event: Row | null): Status => ({
  mood, message, reason, eventId: event?.id ?? null, eventTitle: event?.title ?? null,
});

const recent = (at: number | null | undefined, now: number, window: number) => at != null && at >= now - window && at <= now;
const after = (at: number | null | undefined, cheered: number | null | undefined) => cheered == null || (at != null && at > cheered);
const suffix = (reason: string | null | undefined) => (reason && reason.trim() ? `: ${reason}` : "");
const zoneOf = (event: Row) => event.timeZone ?? ZONE;

function requests(n: number) {
  if (n % 100 >= 11 && n % 100 <= 14) return "новых заявок";
  switch (n % 10) {
    case 1: return "новая заявка";
    case 2: case 3: case 4: return "новые заявки";
    default: return "новых заявок";
  }
}

function dayWord(event: Row, start: number, now: number) {
  const z = zoneOf(event);
  const key = (ms: number) => {
    const p = partsIn(ms, z);
    return Date.UTC(p.y, p.m - 1, p.d) / DAY;
  };
  const diff = key(start) - key(now);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  return dateText(start, z);
}

export function petStatus(userId: string, now: number): Status {
  const user = db.users.get(userId) as Row;
  const cheered: number | null = user.petCheeredAt ?? null;
  const mine = db.registrations.rows.filter((r) => r.userId === userId).sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const organized = db.events.rows
    .filter((e) => e.authorId === userId || db.eventOrganizers.rows.some((o) => o.eventId === e.id && o.userId === userId))
    .sort((a, b) => b.startAt - a.startAt);
  const related = new Map<string, Row>();
  for (const r of mine) {
    const e = db.events.get(r.eventId);
    if (e) related.set(e.id as string, e);
  }
  for (const e of organized) related.set(e.id as string, e);
  const latestModeration = (a: Row, b: Row) => b.moderatedAt - a.moderatedAt || String(a.id).localeCompare(String(b.id));
  const moderated = (e: Row | undefined): e is Row =>
    !!e && (e.status === "UNPUBLISHED" || e.status === "DELETED") && recent(e.moderatedAt, now, 7 * DAY);

  // 1. Недавно снятая встреча автора или соорганизатора.
  const own = organized.filter((e) => moderated(e) && after(e.moderatedAt, cheered)).sort(latestModeration)[0];
  if (own) return state("offended", `Мою встречу «${own.title}» сняли${suffix(own.moderationReason)}`, "ORGANIZED_EVENT_MODERATED", own);
  // 2. Недавно снятая встреча, на которую пользователь записан или ожидает решения.
  const joined = mine
    .filter((r) => r.status === "CONFIRMED" || r.status === "PENDING")
    .map((r) => related.get(r.eventId))
    .filter((e): e is Row => moderated(e) && after(e.moderatedAt, cheered))
    .sort(latestModeration)[0];
  if (joined) return state("sad", `Встречу «${joined.title}» отменили${suffix(joined.moderationReason)}`, "REGISTERED_EVENT_MODERATED", joined);

  const decisions = mine
    .filter((r) => r.decidedAt != null)
    .sort((a, b) => b.decidedAt - a.decidedAt || String(a.id).localeCompare(String(b.id)));
  // 3. Отказ за последние трое суток.
  for (const r of decisions) {
    if (r.status === "REJECTED" && recent(r.decidedAt, now, 3 * DAY) && after(r.decidedAt, cheered)) {
      const event = related.get(r.eventId) as Row;
      return state("sad", `Не взяли на «${event.title}»${suffix(r.decisionReason)}`, "REGISTRATION_REJECTED", event);
    }
  }
  // 4. Одобрение организатором за последние сутки; свободная запись сюда не попадает.
  for (const r of decisions) {
    if (r.status === "CONFIRMED" && r.decidedById && recent(r.decidedAt, now, DAY)) {
      const event = related.get(r.eventId) as Row;
      return state("wink", `Меня приняли на «${event.title}»!`, "REGISTRATION_APPROVED", event);
    }
  }
  // 4а. Новое достижение за последние сутки.
  const achievement = db.userAchievements.rows
    .filter((a) => a.userId === userId && recent(a.createdAt, now, DAY))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (achievement) return state("happy", `Новое достижение: «${ACHIEVEMENTS[achievement.code as AchievementCode].title}»!`, "ACHIEVEMENT_EARNED", null);
  // 4б. Монеты за встречу за последние сутки: сумма начислений за последнее занятие.
  const earned = db.coinLedger.rows
    .filter((e) => e.userId === userId && ["MEETING", "FIRST_MEETING", "ORGANIZER_MEETING", "FIRST_ORGANIZED"].includes(e.kind) && recent(e.createdAt, now, DAY))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (earned.length && earned[0].eventId) {
    const latest = earned[0];
    const sum = earned.filter((e) => e.occurrenceId === latest.occurrenceId).reduce((s, e) => s + e.amount, 0);
    const event = db.events.get(latest.eventId);
    if (event) {
      const offer = owns(userId, "hat:cap") ? "Заглянем в магазин?" : "Купим кепку?";
      return state("wink", `+${sum} монет за «${event.title}»! ${offer}`, "COINS_EARNED", event);
    }
  }

  // Следующее SCHEDULED-занятие: старое начало серии и отменённые даты не считаются будущей встречей.
  const starts = new Map<string, number>();
  for (const o of db.eventOccurrences.rows) {
    if (o.status !== "SCHEDULED" || o.startAt <= now || !related.has(o.eventId)) continue;
    const cur = starts.get(o.eventId);
    if (cur === undefined || o.startAt < cur) starts.set(o.eventId, o.startAt);
  }
  const future = (e: Row | undefined): e is Row => !!e && e.status === "PUBLISHED" && starts.has(e.id as string);
  const nearest = (a: Row, b: Row) => (starts.get(a.id) as number) - (starts.get(b.id) as number) || String(a.id).localeCompare(String(b.id));
  const confirmed = mine.filter((r) => r.status === "CONFIRMED").map((r) => related.get(r.eventId)).filter(future).sort(nearest);
  // 5. Подтверждённая встреча не позднее чем через 48 часов.
  if (confirmed.length) {
    const event = confirmed[0];
    const start = starts.get(event.id as string) as number;
    if (start <= now + 48 * HOUR) {
      return state("happy", `Скоро «${event.title}» — ${dayWord(event, start, now)} в ${timeText(start, zoneOf(event))}!`, "EVENT_SOON", event);
    }
  }
  // 6. Заявки на будущие опубликованные встречи организатора; выбирается ближайшая встреча.
  const futureOrganized = organized.filter(future).sort(nearest);
  for (const event of futureOrganized) {
    const n = db.registrations.rows.filter((r) => r.eventId === event.id && r.status === "PENDING").length;
    if (n > 0) return state("surprised", `${n} ${requests(n)} на «${event.title}»`, "NEW_REQUESTS", event);
  }
  // 7. Собственная заявка на будущую опубликованную встречу.
  const pending = mine.filter((r) => r.status === "PENDING").map((r) => related.get(r.eventId)).filter(future).sort(nearest)[0];
  if (pending) return state("thinking", `Жду ответа по «${pending.title}»`, "AWAITING_APPROVAL", pending);
  // 8. Нет будущих встреч и активности за последние 14 дней.
  if (
    !confirmed.length && !futureOrganized.length && !recent(cheered, now, DAY) &&
    !mine.some((r) => recent(r.createdAt, now, 14 * DAY)) &&
    !organized.filter((e) => e.authorId === userId).some((e) => recent(e.createdAt, now, 14 * DAY))
  ) {
    return state("sleep", "Давно не тренировались… Найдём компанию?", "INACTIVE", null);
  }
  // 9. Обычное состояние, с ближайшей подтверждённой встречей, если она есть.
  if (confirmed.length) {
    const event = confirmed[0];
    return state("idle", `Ближайшая встреча: «${event.title}» ${dayWord(event, starts.get(event.id as string) as number, now)}`, "DEFAULT", event);
  }
  return state("idle", "Найдём компанию для тренировки?", "DEFAULT", null);
}

// ---------- образ пользователя ----------

function petResponse(userId: string, catalog: Catalog, own: boolean, now: number) {
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  const look = petLook(user, catalog, equipmentOf(userId));
  if (!own) return { ...look, mood: "idle" };
  const status = petStatus(userId, now);
  return { ...look, mood: status.mood, status };
}

export function getPet(userId: string, now: number) {
  return petResponse(userId, loadCatalog(), true, now);
}

/** Публичный образ без личных событий и причин настроения, даже при просмотре своего id. */
export function getPublicPet(userId: string, now: number) {
  return petResponse(userId, loadCatalog(), false, now);
}

export function cheerPet(userId: string, now: number) {
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  user.petCheeredAt = now;
  db.users.touch();
  return petResponse(userId, loadCatalog(), true, now);
}

export function renamePet(userId: string, name: string | undefined, now: number) {
  const normalized = (name ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > 30) throw badRequest("Имя питомца — от 1 до 30 символов");
  const user = db.users.get(userId);
  if (!user) throw notFound("Пользователь не найден");
  user.petName = normalized;
  db.users.touch();
  return petResponse(userId, loadCatalog(), true, now);
}

function resolve(catalog: Catalog, slotCode: string, itemCode: string): Row {
  const slot = catalog.slot(slotCode);
  if (!slot) throw badRequest(`Неизвестный слот «${slotCode}»`);
  if (!itemCode.trim() || (slot.kind === "OUTFIT" && itemCode === NO_ACTIVITY)) {
    throw badRequest(`Пустая вещь в слоте «${slot.label}»: чтобы снять, не передавайте слот`);
  }
  const item = catalog.item(slot, itemCode);
  if (!item) throw badRequest(`Нет вещи «${itemCode}» в слоте «${slot.label}»`);
  return item;
}

function requireOwned(userId: string, catalog: Catalog, wanted: Row[]) {
  const owned = ownedIds(userId, catalog);
  for (const item of wanted) {
    if (!owned.has(item.id as string)) {
      const how = item.kind === "EXCLUSIVE" ? `её дают ${item.unlockHint}` : `купи её в магазине за ${item.price} монет`;
      throw conflict(`Вещь «${item.label}» ещё не твоя: ${how}`);
    }
  }
}

/** Проверить весь образ, не изменяя надетое. Возвращает слот → вещь. */
export function checkedLook(userId: string, catalog: Catalog, activity: string, outfit: Record<string, string | null>): Map<Row, Row> {
  const chosen = new Map<Row, Row>();
  const activitySlot = catalog.slots.find((s) => s.kind === "ACTIVITY") as Row;
  chosen.set(activitySlot, resolve(catalog, ACTIVITY, activity));
  for (const [slotCode, itemCode] of Object.entries(outfit ?? {})) {
    const slot = catalog.slot(slotCode);
    if (!slot || slot.kind !== "OUTFIT") throw badRequest(`Неизвестный слот одежды «${slotCode}»`);
    if (itemCode != null) chosen.set(slot, resolve(catalog, slotCode, itemCode));
  }
  requireOwned(userId, catalog, [...chosen.values()]);
  return chosen;
}

export function savePet(userId: string, activity: string, outfit: Record<string, string | null>, now: number) {
  const catalog = loadCatalog();
  const chosen = checkedLook(userId, catalog, activity, outfit);
  db.userPetEquipment.removeWhere((e) => e.userId === userId);
  for (const [slot, item] of chosen) {
    db.userPetEquipment.insert({ id: newId(), itemId: item.id, slotId: slot.id, userId, createdAt: now, updatedAt: now });
  }
  return petResponse(userId, catalog, true, now);
}

export function equipPet(userId: string, slotCode: string, itemCode: string | null | undefined, now: number) {
  const catalog = loadCatalog();
  const slot = catalog.slot(slotCode);
  if (!slot) throw notFound(`Слот «${slotCode}» не найден`);
  const current = db.userPetEquipment.find((e) => e.userId === userId && e.slotId === slot.id);
  if (itemCode == null) {
    if (current) db.userPetEquipment.remove(current.id as string);
  } else {
    const item = resolve(catalog, slotCode, itemCode);
    requireOwned(userId, catalog, [item]);
    if (current) db.userPetEquipment.update(current.id as string, { itemId: item.id, updatedAt: now });
    else db.userPetEquipment.insert({ id: newId(), itemId: item.id, slotId: slot.id, userId, createdAt: now, updatedAt: now });
  }
  return petResponse(userId, catalog, true, now);
}

// ---------- каталог и магазин ----------

export function catalogResponse() {
  const catalog = loadCatalog();
  return {
    slots: catalog.slots.map((slot) => ({
      id: slot.code,
      label: slot.label,
      kind: slot.kind,
      builtIn: slot.builtIn,
      items: (catalog.itemsBySlot.get(slot.id as string) ?? []).map((item) => ({
        id: item.code,
        label: item.label,
        builtIn: item.builtIn,
        art: item.svg == null ? null : { bodyPart: item.bodyPart, svg: item.svg, x: item.fitX, y: item.fitY, scale: item.fitScale },
      })),
    })),
  };
}

export type ShopItem = {
  id: string; slot: string; code: string; label: string; price: number; kind: string; owned: boolean;
  hint: string | null; isNew: boolean; legendary: boolean;
};

export function shop(userId: string): ShopItem[] {
  requireUserAccount(userId);
  const catalog = loadCatalog();
  const owned = ownedIds(userId, catalog);
  const out: ShopItem[] = [];
  for (const slot of catalog.slots) {
    if (slot.kind !== "OUTFIT" && slot.kind !== "ACTIVITY") continue;
    for (const item of catalog.itemsBySlot.get(slot.id as string) ?? []) {
      out.push({
        id: `${slot.code}:${item.code}`,
        slot: slot.code,
        code: item.code,
        label: item.label,
        price: item.price,
        kind: item.kind,
        owned: owned.has(item.id as string),
        hint: item.kind === "EXCLUSIVE" ? `Дают ${item.unlockHint}` : null,
        isNew: isNewItem(item.code),
        legendary: item.kind === "EXCLUSIVE",
      });
    }
  }
  return out;
}

export function buyItem(userId: string, id: string, now: number): ShopItem {
  requireUserAccount(userId);
  const catalog = loadCatalog();
  const item = findItem(catalog, id);
  const slot = catalog.slots.find((s) => s.id === item.slotId) as Row;
  if (item.kind === "EXCLUSIVE") throw conflict(`Эту вещь нельзя купить — её дают ${item.unlockHint}`);
  if (ownedIds(userId, catalog).has(item.id as string)) throw conflict("Эта вещь уже у тебя");
  applyCoins(userId, -item.price, "PURCHASE", `PURCHASE:${item.id}:${userId}`, `Покупка: ${item.label}`, null, null, now);
  addItemToInventory(userId, item.id as string);
  return {
    id: `${slot.code}:${item.code}`, slot: slot.code, code: item.code, label: item.label, price: item.price, kind: item.kind,
    owned: true, hint: null, isNew: isNewItem(item.code), legendary: false,
  };
}

// ---------- комплекты ----------

type Bundle = { code: string; label: string; category: { code: string; label: string }; outfit: Record<string, string>; activity: string };
const bundleDefs = () => meta.bundles as Bundle[];

function bundleResponse(bundle: Bundle, items: ShopItem[]) {
  const parts = items.filter((item) =>
    item.slot === ACTIVITY ? bundle.activity !== NO_ACTIVITY && item.code === bundle.activity : item.code === bundle.outfit[item.slot],
  );
  const missing = parts.filter((item) => !item.owned);
  const fullPrice = missing.reduce((s, i) => s + i.price, 0);
  const price = missing.length >= 2 ? Math.floor((fullPrice * 80) / 100) : fullPrice;
  const reason = missing.filter((i) => i.kind === "EXCLUSIVE").map((i) => `Вещь «${i.label}» ещё не твоя: ${i.hint}`).join("; ");
  return {
    code: bundle.code, label: bundle.label, category: bundle.category, outfit: bundle.outfit, activity: bundle.activity,
    items: parts, fullPrice, price, missingCount: missing.length, owned: missing.length === 0,
    locked: reason.length > 0, lockedReason: reason ? reason : null,
  };
}

export function bundles(userId: string) {
  const items = shop(userId);
  return bundleDefs().map((b) => bundleResponse(b, items));
}

export function buyBundle(userId: string, code: string, now: number) {
  requireUserAccount(userId);
  const bundle = bundleDefs().find((b) => b.code === code);
  if (!bundle) throw notFound(`Комплект «${code}» не найден`);
  const response = bundleResponse(bundle, shop(userId));
  if (response.locked) throw conflict(response.lockedReason as string);
  const catalog = loadCatalog();
  const owned = new Set(db.userItems.rows.filter((r) => r.userId === userId).map((r) => r.itemId as string));
  const wanted: Row[] = [];
  for (const [slotCode, itemCode] of Object.entries({ ...bundle.outfit, [ACTIVITY]: bundle.activity })) {
    const slot = catalog.slot(slotCode) as Row;
    const item = catalog.item(slot, itemCode) as Row;
    if (item.code !== NO_ACTIVITY) wanted.push(item);
  }
  const missing = wanted.filter((item) => item.kind !== "BASE" && !owned.has(item.id as string));
  if (missing.length) {
    const fingerprint = missing.map((i) => i.id).sort().join(",");
    applyCoins(userId, -response.price, "PURCHASE", `BUNDLE:${userId}:${code}:${fingerprint}`, `Покупка комплекта: ${bundle.label}`, null, null, now);
    for (const item of missing) addItemToInventory(userId, item.id as string);
  }
  return savePet(userId, bundle.activity, bundle.outfit, now);
}

export function buySet(userId: string, ids: string[], wear: boolean, now: number) {
  requireUserAccount(userId);
  const user = db.users.get(userId) as Row;
  const available = new Map(shop(userId).map((i) => [i.id, i]));
  const wanted = [...new Set(ids)].map((id) => {
    const item = available.get(id);
    if (!item) throw notFound(`Вещь «${id}» не найдена`);
    if (item.kind === "EXCLUSIVE") throw conflict(`Эту вещь нельзя купить — ${item.hint}`);
    return item;
  });
  if (new Set(wanted.map((i) => i.slot)).size !== wanted.length) throw badRequest("Выберите одну вещь для каждого слота");
  const missing = wanted.filter((i) => !i.owned);
  const total = missing.reduce((s, i) => s + i.price, 0);
  const price = missing.length >= 2 ? Math.floor((total * 80) / 100) : total;
  if (user.coins < price) throw conflict(`Не хватает ${price - user.coins} монет`);
  if (missing.length) {
    const fingerprint = missing.map((i) => i.id).sort().join(",");
    applyCoins(userId, -price, "PURCHASE", `SET:${userId}:${fingerprint}`, "Покупка примеренных вещей", null, null, now);
    const catalog = loadCatalog();
    for (const item of missing) addItemToInventory(userId, findItem(catalog, item.id).id as string);
  }
  const current = getPet(userId, now);
  if (!wear) return current;
  const outfit: Record<string, string | null> = { ...current.outfit };
  let activity = current.activity;
  for (const item of wanted) {
    if (item.slot === ACTIVITY) activity = item.code;
    else outfit[item.slot] = item.code;
  }
  return savePet(userId, activity, outfit, now);
}

// ---------- сохранённые образы ----------

const lookResponse = (look: Row) => ({ id: look.id, name: look.name, activity: look.activity, outfit: look.outfit ?? {} });

export function savedLooks(userId: string) {
  requireUserAccount(userId);
  return db.petSavedLooks.rows.filter((l) => l.userId === userId).sort((a, b) => a.createdAt - b.createdAt).map(lookResponse);
}

export function saveLook(userId: string, name: string, activity: string, outfit: Record<string, string | null>, now: number) {
  requireUserAccount(userId);
  const catalog = loadCatalog();
  checkedLook(userId, catalog, activity, outfit);
  if (db.petSavedLooks.rows.filter((l) => l.userId === userId).length >= MAX_LOOKS) throw conflict(`Можно сохранить не больше ${MAX_LOOKS} образов`);
  const clean = Object.fromEntries(Object.entries(outfit ?? {}).filter(([, v]) => v != null)) as Record<string, string>;
  return lookResponse(db.petSavedLooks.insert({ id: newId(), userId, name, activity, outfit: clean, createdAt: now, updatedAt: now }));
}

export function deleteLook(userId: string, id: string) {
  requireUserAccount(userId);
  const look = db.petSavedLooks.get(id);
  if (!look || look.userId !== userId) throw notFound("Образ не найден");
  db.petSavedLooks.remove(id);
}
