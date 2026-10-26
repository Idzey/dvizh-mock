// База мока: таблицы в памяти, засеянные снапшотом настоящего демо-стенда и сохраняемые в IndexedDB.
import snapshotMeta from "../seed/snapshot.meta.json";
import snapshotUrl from "../seed/snapshot.json?url";
import { clearPersisted, deleteBlob, loadPersisted, writeBlob, writeTables, type Meta } from "./persist";
import { shiftTables, weeksToShift, type SnapshotSchema } from "./shift";
import { setDirtyListener, Table, type Row } from "./table";

export { Table, type Row } from "./table";
export { isPersistent } from "./persist";

const TABLE_NAMES = [
  "users", "sports", "events", "eventScheduleRules", "eventOccurrences", "occurrenceAttendances", "registrations",
  "eventOrganizers", "organizerInvitations", "comments", "organizations", "organizationSports",
  "organizationSubscriptions", "organizationAwards", "files", "petSlots", "petItems", "userPetEquipment", "userItems",
  "petSavedLooks", "coinLedger", "userAchievements", "userSports", "userPreferences", "notifications",
  "notificationInboxes", "notificationSettings", "personalReminders", "recommendationDismissals", "blogPosts",
  "blogPostPhotos", "blogPostLikes", "blogComments", "moderationChecks",
  // только мок
  "credentials", "jobs",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export const db = Object.fromEntries(TABLE_NAMES.map((name) => [name, new Table(name)])) as Record<TableName, Table>;

type Snapshot = {
  version: string;
  exportedAt: number;
  schema: SnapshotSchema;
  sportImages: Record<string, string>;
  bundles: unknown[];
  tables: Record<string, Row[]>;
};

export const meta: Meta = { seedVersion: "", anchor: 0, lastUserWriteAt: 0, schema: {}, sportImages: {}, bundles: [], seedFiles: {} };

/** URL загруженных пользователем файлов: id → blob URL. */
export const blobUrls = new Map<string, string>();

const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let metaDirty = false;
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("dvizh-mock") : null;

async function flush() {
  timer = undefined;
  if (!dirty.size && !metaDirty) return;
  const out: Record<string, Row[]> = {};
  for (const name of dirty) out[name] = db[name as TableName].rows;
  dirty.clear();
  metaDirty = false;
  await writeTables(out, meta);
  channel?.postMessage({ type: "changed" });
}

/** Любая запись пользователя двигает lastUserWriteAt — по нему решается, на сколько недель сдвигать мир при следующем входе. */
export function markUserWrite() {
  meta.lastUserWriteAt = Date.now();
  metaDirty = true;
}

setDirtyListener((name) => {
  dirty.add(name);
  metaDirty = true;
  if (!timer) timer = setTimeout(flush, 250);
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void flush());
  channel?.addEventListener("message", (event) => {
    // другая вкладка изменила мир — проще всего подхватить его перезагрузкой, пока вкладка не редактирует
    if (event.data?.type === "changed" && document.visibilityState === "hidden") location.reload();
    if (event.data?.type === "reset") location.reload();
  });
}

/** Склеивает вспомогательные таблицы снапшота с родителями: в моке это обычные поля. */
function fold(tables: Record<string, Row[]>) {
  const contacts = new Map<string, Record<string, string>>();
  for (const c of tables.organizationContacts ?? []) {
    const bag = contacts.get(c.organizationId) ?? {};
    bag[c.contactType] = c.contactValue;
    contacts.set(c.organizationId, bag);
  }
  for (const org of tables.organizations ?? []) org.contacts = contacts.get(org.id as string) ?? {};

  const days = new Map<string, string[]>();
  for (const d of tables.userPreferenceDays ?? []) {
    const list = days.get(d.preferencesId) ?? [];
    list.push(d.dayOfWeek);
    days.set(d.preferencesId, list);
  }
  for (const p of tables.userPreferences ?? []) p.days = days.get(p.id as string) ?? [];

  const channels = new Map<string, string[]>();
  for (const c of tables.notificationSettingChannels ?? []) {
    channels.set(c.settingsId, [...(channels.get(c.settingsId) ?? []), c.channel]);
  }
  const categories = new Map<string, string[]>();
  for (const c of tables.notificationSettingCategories ?? []) {
    categories.set(c.settingsId, [...(categories.get(c.settingsId) ?? []), c.category]);
  }
  for (const s of tables.notificationSettings ?? []) {
    s.channels = channels.get(s.id as string) ?? [];
    s.categories = categories.get(s.id as string) ?? [];
  }

  const checkCategories = new Map<string, string[]>();
  for (const c of tables.moderationCheckCategories ?? []) {
    checkCategories.set(c.checkId, [...(checkCategories.get(c.checkId) ?? []), c.category]);
  }
  for (const c of tables.moderationChecks ?? []) c.categories = checkCategories.get(c.id as string) ?? [];

  const outfits = new Map<string, Record<string, string>>();
  for (const o of tables.petSavedLookOutfit ?? []) {
    const bag = outfits.get(o.lookId) ?? {};
    bag[o.slotId] = o.itemId;
    outfits.set(o.lookId, bag);
  }
  for (const l of tables.petSavedLooks ?? []) l.outfit = outfits.get(l.id as string) ?? {};

  for (const name of [
    "organizationContacts", "userPreferenceDays", "notificationSettingChannels", "notificationSettingCategories",
    "moderationCheckCategories", "petSavedLookOutfit",
  ]) {
    delete tables[name];
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

function install(tables: Record<string, Row[]>) {
  for (const name of TABLE_NAMES) db[name].load(tables[name] ?? []);
}

/** Откуда брать снапшот: в браузере — fetch по хешированному URL, в Node-харнессе (scripts/mock-diff.mjs) — файл с диска. */
let loadSnapshot: () => Promise<Snapshot> = async () => (await (await fetch(snapshotUrl)).json()) as Snapshot;
export const setSnapshotLoader = (loader: () => Promise<unknown>) => {
  loadSnapshot = loader as () => Promise<Snapshot>;
};

async function seed(): Promise<void> {
  const snapshot = await loadSnapshot();
  const tables = structuredClone(snapshot.tables);
  fold(tables);
  meta.seedVersion = snapshot.version;
  meta.anchor = snapshot.exportedAt;
  meta.lastUserWriteAt = 0;
  meta.schema = snapshot.schema;
  meta.sportImages = snapshot.sportImages;
  meta.bundles = snapshot.bundles;
  meta.seedFiles = Object.fromEntries(
    (tables.files ?? []).map((f) => [f.id as string, EXT[f.contentType as string] ?? "bin"]),
  );
  // свежий мир: подтягиваем к сегодняшнему дню
  const weeks = weeksToShift(Date.now(), meta.anchor, 0);
  shiftTables(tables, meta.schema, weeks, meta.anchor);
  meta.anchor += weeks * 7 * 24 * 3600 * 1000;
  install(tables);
  for (const name of TABLE_NAMES) dirty.add(name);
  metaDirty = true;
  await flush();
}

let booting: Promise<void> | null = null;

/** Однократная загрузка мира; все запросы ждут её окончания. */
export function boot(): Promise<void> {
  booting ??= (async () => {
    const snapshotVersion = snapshotMeta.version;
    const stored = await loadPersisted();
    if (stored && stored.meta.seedVersion === snapshotVersion) {
      Object.assign(meta, stored.meta);
      const weeks = weeksToShift(Date.now(), meta.anchor, meta.lastUserWriteAt || meta.anchor);
      if (weeks > 0) {
        shiftTables(stored.tables, meta.schema, weeks, meta.anchor);
        meta.anchor += weeks * 7 * 24 * 3600 * 1000;
        for (const name of TABLE_NAMES) dirty.add(name);
        metaDirty = true;
      }
      install(stored.tables);
      for (const [id, blob] of Object.entries(stored.blobs)) blobUrls.set(id, URL.createObjectURL(blob));
      if (dirty.size) await flush();
    } else {
      if (stored) await clearPersisted();
      await seed();
    }
  })();
  return booting;
}

/** Для тестов в Node: мир заново из снапшота, как при первом заходе. */
export async function reseedForTests() {
  booting = null;
  await clearPersisted();
  await boot();
}

/** Файл, загруженный пользователем: blob хранится в IndexedDB, наружу отдаётся blob URL. */
export async function storeBlob(id: string, blob: Blob) {
  blobUrls.set(id, URL.createObjectURL(blob));
  await writeBlob(id, blob);
}

export async function dropBlob(id: string) {
  const url = blobUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(id);
  await deleteBlob(id);
}

/** «Сбросить демо»: стираем всё и перезагружаем страницу — мир пересоздастся из снапшота. */
export async function resetWorld() {
  await clearPersisted();
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // не критично
  }
  channel?.postMessage({ type: "reset" });
  location.href = "/";
}

export const SESSION_KEY = "dvizh-mock-session";
export const getSessionUserId = (): string | null => {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
};
export const setSessionUserId = (id: string | null) => {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // без localStorage сессия живёт до перезагрузки
    memorySession = id;
  }
};
let memorySession: string | null = null;
export const currentSessionUserId = () => getSessionUserId() ?? memorySession;
