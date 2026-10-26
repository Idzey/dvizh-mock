// Файлы пользователя (порт FileService): проверка формата по первым байтам и хранение blob в IndexedDB.
// Скачивания нет: ссылки /api/files/{id} ядро подменяет на blob URL или статику (см. core.rewriteFileUrls).
import { db, dropBlob, storeBlob, type Row } from "../db";
import { badRequest, notFound } from "../http";
import { newId } from "../util/ids";

export const FILE_NOT_FOUND = "Файл не найден";
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export type FileKind = "AVATAR" | "ORG_LOGO" | "ORG_DOCUMENT" | "EVENT_PHOTO" | "BLOG_PHOTO" | "ALBUM_PHOTO" | "USER_PHOTO" | "SPORT_IMAGE";

const startsWith = (b: Uint8Array, ...prefix: (number | string)[]) =>
  b.length >= prefix.length && prefix.every((p, i) => b[i] === (typeof p === "string" ? p.charCodeAt(0) : p));

function detectType(b: Uint8Array): string | null {
  if (startsWith(b, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(b, 0x89, "P", "N", "G", 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(b, "R", "I", "F", "F") && b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (startsWith(b, "%", "P", "D", "F", "-")) return "application/pdf";
  return null;
}

/** Имя без пути и управляющих символов; пустое — «file.<расширение>». */
function originalName(name: string | undefined, contentType: string) {
  let cleaned = (name ?? "").replace(/.*[/\\]/, "").replace(/\p{Cc}/gu, "").trim();
  if (!cleaned) cleaned = `file.${contentType.split("/").pop() ?? "bin"}`;
  return cleaned.length > 255 ? cleaned.slice(-255) : cleaned;
}

/** Файл из multipart-формы: поле `file` (или `files`). */
export function formFile(form: FormData | null, field = "file"): File {
  const value = form?.get(field);
  if (!(value instanceof Blob)) throw badRequest("Файл не передан");
  return value as File;
}

export async function storeUpload(
  kind: FileKind,
  file: File,
  uploadedById: string,
  organizationId: string | null,
  eventId: string | null,
  position: number | null,
  now = Date.now(),
): Promise<Row> {
  if (!file.size) throw badRequest("Файл пустой");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = detectType(head);
  const document = kind === "ORG_DOCUMENT";
  const allowed = document ? ["application/pdf", "image/jpeg", "image/png"] : ["image/jpeg", "image/png", "image/webp"];
  if (!type || !allowed.includes(type)) {
    throw badRequest(document ? "Документ должен быть в формате PDF, JPG или PNG" : "Изображение должно быть в формате JPG, PNG или WebP");
  }
  const max = document ? DOCUMENT_MAX_BYTES : IMAGE_MAX_BYTES;
  if (file.size > max) throw badRequest(`Файл слишком большой: максимум ${max / 1024 / 1024} МБ`);
  const id = newId();
  await storeBlob(id, new Blob([await file.arrayBuffer()], { type }));
  return db.files.insert({
    id, kind, focusX: null, focusY: null, caption: null, eventId, position, createdAt: now, sizeBytes: file.size, updatedAt: now,
    contentType: type, originalName: originalName((file as File).name, type), uploadedById, organizationId,
  });
}

export function deleteFile(file: Row) {
  db.files.remove(file.id as string);
  void dropBlob(file.id as string);
}

export function setFocus(file: Row, focus: { x?: number; y?: number } | null | undefined) {
  file.focusX = focus?.x ?? null;
  file.focusY = focus?.y ?? null;
  db.files.touch();
}

export const eventPhotosOf = (eventId: string): Row[] =>
  db.files.rows
    .filter((f) => f.eventId === eventId && f.kind === "EVENT_PHOTO")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt);

/** Обложки для списка: eventId → первое фото. */
export function eventCovers(eventIds: Set<string>): Map<string, Row> {
  const covers = new Map<string, Row>();
  const photos = db.files.rows
    .filter((f) => f.kind === "EVENT_PHOTO" && f.eventId && eventIds.has(f.eventId))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt);
  for (const f of photos) if (!covers.has(f.eventId)) covers.set(f.eventId, f);
  return covers;
}

export function requireFile(fileId: string): Row {
  const f = db.files.get(fileId);
  if (!f) throw notFound(FILE_NOT_FOUND);
  return f;
}

export const newFileId = newId;
