// Персист мока в IndexedDB: таблицы целиком (пишутся только изменённые), мета-данные и загруженные пользователем файлы.
// Если IndexedDB недоступна (приватный режим, запрет сайта), мир живёт в памяти до перезагрузки.
import type { Row } from "./table";

const DB_NAME = "dvizh-mock";
const VERSION = 1;

export type Meta = {
  seedVersion: string;
  /** Момент, к которому «подтянут» мир (начинается с exportedAt снапшота, растёт при сдвигах). */
  anchor: number;
  lastUserWriteAt: number;
  schema: Record<string, { instants: string[]; dates: string[]; localDateTimes: string[] }>;
  sportImages: Record<string, string>;
  /** Готовые комплекты бобра: в бэкенде это константы Java, поэтому лежат в снапшоте. */
  bundles: unknown[];
  /** id файлов из снапшота → расширение в /media/files. */
  seedFiles: Record<string, string>;
};

export type Persisted = {
  meta: Meta;
  tables: Record<string, Row[]>;
  blobs: Record<string, Blob>;
};

let idb: IDBDatabase | null = null;
let degraded = false;
export const isPersistent = () => !degraded;

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function open(): Promise<IDBDatabase | null> {
  if (idb) return idb;
  if (typeof indexedDB === "undefined") return null;
  try {
    idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const store of ["tables", "meta", "blobs"]) {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
    return idb;
  } catch {
    return null;
  }
}

export async function loadPersisted(): Promise<Persisted | null> {
  const conn = await open();
  if (!conn) {
    degraded = true;
    return null;
  }
  try {
    const tx = conn.transaction(["tables", "meta", "blobs"], "readonly");
    const meta = (await request(tx.objectStore("meta").get("meta"))) as Meta | undefined;
    if (!meta) return null;
    const tableStore = tx.objectStore("tables");
    const keys = (await request(tableStore.getAllKeys())) as string[];
    const values = (await request(tableStore.getAll())) as Row[][];
    const tables = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
    const blobStore = tx.objectStore("blobs");
    const blobKeys = (await request(blobStore.getAllKeys())) as string[];
    const blobValues = (await request(blobStore.getAll())) as Blob[];
    const blobs = Object.fromEntries(blobKeys.map((key, i) => [key, blobValues[i]]));
    return { meta, tables, blobs };
  } catch {
    degraded = true;
    return null;
  }
}

export async function clearPersisted() {
  const conn = await open();
  if (!conn) return;
  const tx = conn.transaction(["tables", "meta", "blobs"], "readwrite");
  for (const store of ["tables", "meta", "blobs"]) tx.objectStore(store).clear();
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export async function writeTables(tables: Record<string, Row[]>, meta?: Meta) {
  const conn = await open();
  if (!conn) {
    degraded = true;
    return;
  }
  try {
    const tx = conn.transaction(["tables", "meta"], "readwrite");
    for (const [name, rows] of Object.entries(tables)) tx.objectStore("tables").put(rows, name);
    if (meta) tx.objectStore("meta").put(meta, "meta");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    degraded = true;
  }
}

export async function writeBlob(id: string, blob: Blob) {
  const conn = await open();
  if (!conn) return;
  try {
    const tx = conn.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(blob, id);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    degraded = true;
  }
}

export async function deleteBlob(id: string) {
  const conn = await open();
  if (!conn) return;
  try {
    conn.transaction("blobs", "readwrite").objectStore("blobs").delete(id);
  } catch {
    // не критично
  }
}
