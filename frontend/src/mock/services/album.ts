// Альбом профиля (порт AlbumService): фото с занятий, разложенные по папкам (папка = мероприятие).
import { db, type Row } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../http";
import { fileUrl, iso, sportResponse } from "./common";
import { deleteFile, formFile, storeUpload } from "./files";
import { isOrganizer, registrationOf } from "./policy";

const MAX_PHOTOS = 200;
const MAX_CAPTION = 300;
const PHOTO_NOT_FOUND = "Фото не найдено в твоём альбоме";

const albumEvent = (e: Row) => ({ id: e.id, title: e.title, startAt: iso(e.startAt), status: e.status, sport: sportResponse(db.sports.get(e.sportId) as Row) });

function activeUser(userId: string) {
  const u = db.users.get(userId);
  if (!u || !u.active) throw notFound("Пользователь не найден");
}

const checkCaption = (caption: string | null | undefined) => {
  if (caption && caption.trim().length > MAX_CAPTION) throw badRequest(`Подпись не длиннее ${MAX_CAPTION} символов`);
};

const photoResponse = (f: Row, mine: boolean) => ({
  id: f.id,
  url: fileUrl(f.id),
  caption: f.caption ?? null,
  createdAt: iso(f.createdAt),
  mine,
  event: albumEvent(db.events.get(f.eventId) as Row),
});

const albumOf = (userId: string) => db.files.rows.filter((f) => f.kind === "ALBUM_PHOTO" && f.uploadedById === userId && db.events.get(f.eventId));

export function albumPhotos(userId: string, viewerId: string, eventId: string | undefined, sportId: string | undefined, sort: string, page: number, size: number) {
  activeUser(userId);
  const dir = sort === "OLDEST" ? 1 : -1;
  const all = albumOf(userId)
    .filter((f) => (!eventId || f.eventId === eventId) && (!sportId || db.events.get(f.eventId)?.sportId === sportId))
    .sort((a, b) => dir * (a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id))));
  const s = Math.min(Math.max(size, 1), 100);
  const p = Math.max(page, 0);
  return {
    items: all.slice(p * s, p * s + s).map((f) => photoResponse(f, userId === viewerId)),
    page: p,
    size: s,
    totalElements: all.length,
    totalPages: Math.ceil(all.length / s),
  };
}

export function albumFolders(userId: string) {
  activeUser(userId);
  const byEvent = new Map<string, Row[]>();
  for (const f of albumOf(userId).sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)))) {
    byEvent.set(f.eventId, [...(byEvent.get(f.eventId) ?? []), f]);
  }
  return [...byEvent.entries()]
    .map(([eventId, files]) => ({ event: db.events.get(eventId) as Row, files }))
    .sort((a, b) => b.event.startAt - a.event.startAt)
    .map(({ event, files }) => ({ event: albumEvent(event), photoCount: files.length, coverUrl: fileUrl(files[0].id) }));
}

/** С каких занятий можно добавить фото: уже начались, не удалены, я организатор или подтверждённый участник. */
export function eligibleEvents(userId: string, now: number) {
  return db.events.rows
    .filter((e) => e.status !== "DELETED" && e.startAt <= now)
    .filter((e) => e.authorId === userId || isOrganizer(e, userId) || registrationOf(e.id as string, userId)?.status === "CONFIRMED")
    .sort((a, b) => b.startAt - a.startAt)
    .slice(0, 50)
    .map(albumEvent);
}

export async function addAlbumPhoto(userId: string, eventId: string | undefined, caption: string | undefined, form: FormData | null, now: number) {
  if (!eventId) throw badRequest("Выбери занятие — без него фото не добавить");
  checkCaption(caption);
  const event = db.events.get(eventId);
  if (!event) throw notFound("Мероприятие не найдено");
  if (event.status === "DELETED") throw conflict("Мероприятие удалено — фото к нему не добавить");
  const participant = registrationOf(eventId, userId)?.status === "CONFIRMED";
  if (!participant && !isOrganizer(event, userId)) throw forbidden("Это занятие не твоё: добавлять фото можно только с тех, где ты был или которые организовал");
  if (event.startAt > now) throw conflict("Занятие ещё не началось — фото можно добавить после него");
  if (db.files.rows.filter((f) => f.kind === "ALBUM_PHOTO" && f.uploadedById === userId).length >= MAX_PHOTOS) {
    throw conflict(`Альбом заполнен: не больше ${MAX_PHOTOS} фото. Удали старые, чтобы добавить новые`);
  }
  const photo = await storeUpload("ALBUM_PHOTO", formFile(form), userId, null, eventId, null, now);
  photo.caption = caption?.trim() || null;
  db.files.touch();
  return photoResponse(photo, true);
}

function ownPhoto(userId: string, fileId: string): Row {
  const f = db.files.get(fileId);
  if (!f || f.kind !== "ALBUM_PHOTO" || f.uploadedById !== userId) throw notFound(PHOTO_NOT_FOUND);
  return f;
}

export function captionAlbumPhoto(userId: string, fileId: string, caption: string | undefined) {
  checkCaption(caption);
  const photo = ownPhoto(userId, fileId);
  photo.caption = caption?.trim() || null;
  db.files.touch();
  return photoResponse(photo, true);
}

export function removeAlbumPhoto(userId: string, fileId: string) {
  deleteFile(ownPhoto(userId, fileId));
}
