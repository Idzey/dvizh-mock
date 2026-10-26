// Блог: гайды и посты с тренировки, лайки и комментарии (порт BlogService, BlogCommentService, BlogAccessPolicy и Markdown).
import { db, type Row } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../http";
import { newId } from "../util/ids";
import { DAY } from "../util/time";
import { eventCovers, deleteFile, formFile, storeUpload } from "./files";
import { fileFocus, fileResponse, fileUrl, iso, orgShort, organizationOfAccount, sportResponse, userShort } from "./common";
import { listEvents, summaries as eventSummaries } from "./events";
import { EVENT_NOT_FOUND } from "./occurrences";
import { isOrganizationSuspended, isOrganizer, isSingleCancelled, registrationOf, upcomingStart } from "./policy";

export const POST_NOT_FOUND = "Пост не найден";
const COMMENT_NOT_FOUND = "Комментарий не найден";
const MAX_PAGE_SIZE = 50;
const WIDGET_EVENTS = 3;
const PROMPT_PHOTOS = 9;
const EXCERPT_LENGTH = 200;
const QUOTE_LENGTH = 140;
const WORDS_PER_MINUTE = 180;

// ---------- Markdown без разметки ----------

const CODE_BLOCK = /```[\s\S]*?(```|$)/g;
const LINK = /\[([^\]]*)]\([^)]*\)/g;
const LINE_MARKERS = /^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm;
const INLINE_MARKERS = /\*\*|__|~~|\|\||[*_`]/g;

export function plain(markdown: string | null | undefined): string {
  if (!markdown) return "";
  return markdown.replace(CODE_BLOCK, " ").replace(LINK, "$1").replace(LINE_MARKERS, "").replace(INLINE_MARKERS, "").replace(/\s+/g, " ").trim();
}

export function excerpt(markdown: string | null | undefined, max: number): string {
  const text = plain(markdown);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function readMinutes(markdown: string | null | undefined): number {
  const text = plain(markdown);
  const words = text ? text.split(" ").length : 0;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

// ---------- правила ----------

const user = (id: string): Row => {
  const u = db.users.get(id);
  if (!u) throw notFound("Пользователь не найден");
  return u;
};

function writeBlockedReason(u: Row, organization: Row | undefined): string | null {
  switch (u.systemRole) {
    case "ADMIN":
      return "Администратор не пишет в блог";
    case "ORG":
      return !organization || organization.status !== "APPROVED" ? "Писать от имени организации можно после одобрения заявки" : null;
    default:
      return null;
  }
}

const wasThere = (event: Row, userId: string) => isOrganizer(event, userId) || registrationOf(event.id as string, userId)?.status === "CONFIRMED";
const reportForbiddenReason = (event: Row, userId: string) => (wasThere(event, userId) ? null : "Пост с тренировки пишут участники и организаторы этой встречи");

function reportConflictReason(event: Row, now: number): string | null {
  if (event.status === "DELETED") return "Встреча удалена — написать о ней нельзя";
  if (event.startAt > now) return "Встреча ещё не прошла — пост с тренировки можно написать после неё";
  return null;
}

const canView = (post: Row, userId: string) => post.status === "PUBLISHED" || post.authorId === userId;
const canEdit = (post: Row, userId: string) => post.authorId === userId;
const canDelete = (post: Row, viewer: Row) => canEdit(post, viewer.id as string) || viewer.systemRole === "ADMIN";

function likeBlockedReason(post: Row, viewer: Row): string | null {
  if (post.status !== "PUBLISHED") return "Пост ещё не опубликован";
  return viewer.systemRole === "ADMIN" ? "Администратор не ставит лайки" : null;
}

function commentBlockedReason(post: Row): string | null {
  if (post.status !== "PUBLISHED") return "Пост ещё не опубликован — комментарии откроются после публикации";
  return post.commentsEnabled ? null : "Автор закрыл комментарии";
}

const replyBlockedReason = (post: Row, parent: Row) => (parent.deletedAt ? "Комментарий удалён — ответить на него нельзя" : commentBlockedReason(post));

function commentEditBlockedReason(comment: Row, userId: string): string | null {
  if (comment.authorId !== userId) return "Можно менять только свои комментарии";
  return comment.deletedAt ? "Комментарий уже удалён" : null;
}

/** Пост, который человек вправе видеть; иначе 404 — черновик чужим не показываем даже по ссылке. */
export function visiblePost(postId: string, userId: string): Row {
  const post = db.blogPosts.get(postId);
  if (!post || !canView(post, userId)) throw notFound(POST_NOT_FOUND);
  return post;
}

// ---------- ответы ----------

const photoResponse = (file: Row, caption: string | null | undefined) => ({ id: file.id, url: fileUrl(file.id), caption: caption ?? null, focus: fileFocus(file) });

function blogEvent(e: Row, covers: Map<string, Row>) {
  const cover = covers.get(e.id as string);
  return {
    id: e.id, title: e.title, startAt: iso(e.startAt), status: e.status, sport: sportResponse(db.sports.get(e.sportId) as Row),
    organizer: userShort(db.users.get(e.authorId)), organization: orgShort(e.organizationId ? db.organizations.get(e.organizationId) : null),
    coverUrl: cover ? fileUrl(cover.id) : null,
  };
}

const blogEvents = (list: Row[]) => {
  const covers = eventCovers(new Set(list.map((e) => e.id as string)));
  return new Map(list.map((e) => [e.id as string, blogEvent(e, covers)]));
};

function summaries(page: Row[], viewerId: string) {
  const covers = eventCovers(new Set(page.map((p) => p.eventId).filter(Boolean)));
  const ids = new Set(page.map((p) => p.id as string));
  const photosBy = new Map<string, Row[]>();
  for (const ph of [...db.blogPostPhotos.rows].sort((a, b) => a.position - b.position)) {
    if (ids.has(ph.postId)) photosBy.set(ph.postId, [...(photosBy.get(ph.postId) ?? []), ph]);
  }
  const likes = new Map<string, number>();
  const liked = new Set<string>();
  for (const l of db.blogPostLikes.rows) {
    if (!ids.has(l.postId)) continue;
    likes.set(l.postId, (likes.get(l.postId) ?? 0) + 1);
    if (l.userId === viewerId) liked.add(l.postId);
  }
  const comments = new Map<string, number>();
  for (const c of db.blogComments.rows) if (ids.has(c.postId) && !c.deletedAt) comments.set(c.postId, (comments.get(c.postId) ?? 0) + 1);
  const eventList = [...new Set(page.map((p) => p.eventId).filter(Boolean))].map((id) => db.events.get(id)).filter(Boolean) as Row[];
  const eventsById = new Map(eventList.map((e) => [e.id as string, blogEvent(e, covers)]));
  return page.map((post) => {
    const postPhotos = photosBy.get(post.id) ?? [];
    const coverPhoto = postPhotos[0];
    const coverFile = coverPhoto && db.files.get(coverPhoto.fileId);
    const event = post.eventId ? eventsById.get(post.eventId) : undefined;
    return {
      id: post.id, type: post.type, status: post.status, title: post.title ?? null, excerpt: excerpt(post.body, EXCERPT_LENGTH),
      readMinutes: readMinutes(post.body), cover: coverFile ? photoResponse(coverFile, coverPhoto.caption) : null, photosCount: postPhotos.length,
      sport: post.sportId ? sportResponse(db.sports.get(post.sportId) as Row) : null, event: event ?? null, author: userShort(db.users.get(post.authorId)),
      organization: orgShort(organizationOfAccount(post.authorId)), authorWasThere: post.type === "EVENT_REPORT" && !!event,
      likesCount: likes.get(post.id) ?? 0, likedByMe: liked.has(post.id), commentsCount: comments.get(post.id) ?? 0,
      publishedAt: iso(post.publishedAt), createdAt: iso(post.createdAt), updatedAt: iso(post.updatedAt),
    };
  });
}

function pageOf<T>(all: T[], page: number, size: number, max = MAX_PAGE_SIZE) {
  const s = Math.min(Math.max(size, 1), max);
  const p = Math.max(page, 0);
  return { rows: all.slice(p * s, p * s + s), page: p, size: s, totalElements: all.length, totalPages: Math.ceil(all.length / s) };
}

export function listPosts(f: { type?: string; sportId?: string; authorId?: string; eventId?: string; organizationId?: string; searchText?: string }, page: number, size: number, userId: string) {
  const org = f.organizationId ? db.organizations.get(f.organizationId) : undefined;
  const orgEvents = f.organizationId ? new Set(db.events.rows.filter((e) => e.organizationId === f.organizationId).map((e) => e.id as string)) : null;
  const text = f.searchText?.trim().toLowerCase();
  const found = db.blogPosts.rows
    .filter((p) => p.status === "PUBLISHED")
    .filter((p) => !f.type || p.type === f.type)
    .filter((p) => !f.sportId || p.sportId === f.sportId)
    .filter((p) => !f.authorId || p.authorId === f.authorId)
    .filter((p) => !f.eventId || p.eventId === f.eventId)
    .filter((p) => !orgEvents || (org && p.authorId === org.accountId) || (p.eventId && orgEvents.has(p.eventId)))
    .filter((p) => !text || String(p.title ?? "").toLowerCase().includes(text) || String(p.body ?? "").toLowerCase().includes(text))
    .sort((a, b) => b.publishedAt - a.publishedAt || String(b.id).localeCompare(String(a.id)));
  const { rows, ...meta } = pageOf(found, page, size);
  return { items: summaries(rows, userId), ...meta };
}

export function minePosts(userId: string, status: string | undefined, page: number, size: number) {
  const found = db.blogPosts.rows
    .filter((p) => p.authorId === userId && (!status || p.status === status))
    .sort((a, b) => b.updatedAt - a.updatedAt || String(b.id).localeCompare(String(a.id)));
  const { rows, ...meta } = pageOf(found, page, size);
  return { items: summaries(rows, userId), ...meta };
}

/** Виджет в конце поста: до трёх ближайших встреч клуба или организатора. */
function widget(post: Row, viewerId: string, now: number) {
  if (post.widgetOrganizationId) {
    const org = db.organizations.get(post.widgetOrganizationId);
    if (!org || org.status !== "APPROVED") return null;
    return { organization: orgShort(org), organizer: null, events: listEvents({ organizationId: org.id, page: 0, size: WIDGET_EVENTS }, viewerId, now).items };
  }
  if (post.widgetUserId) {
    const organizer = db.users.get(post.widgetUserId);
    if (!organizer || !organizer.active) return null;
    const upcoming: { event: Row; start: number }[] = [];
    for (const e of db.events.rows) {
      if (!(e.authorId === organizer.id || db.eventOrganizers.rows.some((o) => o.eventId === e.id && o.userId === organizer.id))) continue;
      if (e.status !== "PUBLISHED" || isOrganizationSuspended(e) || isSingleCancelled(e)) continue;
      const start = upcomingStart(e, now);
      if (start !== null && start > now) upcoming.push({ event: e, start });
    }
    const nearest = upcoming.sort((a, b) => a.start - b.start).slice(0, WIDGET_EVENTS).map((x) => x.event);
    return { organization: null, organizer: userShort(organizer), events: eventSummaries(nearest, viewerId, now) };
  }
  return null;
}

export function getPost(postId: string, userId: string, now: number) {
  const post = visiblePost(postId, userId);
  const viewer = user(userId);
  const summary = summaries([post], userId)[0];
  const photos = db.blogPostPhotos.rows
    .filter((p) => p.postId === post.id)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ p, file: db.files.get(p.fileId) }))
    .filter((x) => x.file)
    .map((x) => photoResponse(x.file as Row, x.p.caption));
  const blocked = commentBlockedReason(post);
  return {
    post: summary, body: post.body ?? null, photos, widget: widget(post, userId, now), widgetOrganizationId: post.widgetOrganizationId ?? null,
    widgetUserId: post.widgetUserId ?? null, commentsEnabled: post.commentsEnabled,
    viewer: {
      isMine: canEdit(post, userId), canEdit: canEdit(post, userId), canDelete: canDelete(post, viewer), canLike: likeBlockedReason(post, viewer) === null,
      canComment: blocked === null, commentBlockedReason: blocked,
    },
  };
}

// ---------- запись ----------

function checkWriter(u: Row) {
  const organization = u.systemRole === "ORG" ? organizationOfAccount(u.id as string) : undefined;
  const reason = writeBlockedReason(u, organization);
  if (reason) throw forbidden(reason);
}

type PostRequest = Record<string, any>;

function resolveTarget(r: PostRequest, userId: string, previousEventId: string | null, now: number): { eventId: string | null; sportId: string | null } {
  let target: { eventId: string | null; sportId: string | null };
  if (r.type === "EVENT_REPORT") {
    if (!r.eventId) throw badRequest("Выбери встречу, о которой пост");
    const event = db.events.get(r.eventId);
    if (!event) throw notFound(EVENT_NOT_FOUND);
    if (event.id !== previousEventId) {
      const denied = reportForbiddenReason(event, userId);
      if (denied) throw forbidden(denied);
      const blocked = reportConflictReason(event, now);
      if (blocked) throw conflict(blocked);
    }
    target = { eventId: event.id as string, sportId: event.sportId };
  } else {
    if (r.sportId && !db.sports.get(r.sportId)) throw badRequest("Вид спорта не найден");
    target = { eventId: null, sportId: r.sportId ?? null };
  }
  if (r.widgetOrganizationId && r.widgetUserId) throw badRequest("Виджет показывает встречи либо клуба, либо организатора — выбери одно");
  if (r.widgetOrganizationId && db.organizations.get(r.widgetOrganizationId)?.status !== "APPROVED") throw badRequest("Клуб для виджета не найден или ещё не допущен");
  if (r.widgetUserId && !db.users.get(r.widgetUserId)?.active) throw badRequest("Организатор для виджета не найден");
  return target;
}

const EVENT_PHOTO_KINDS = ["ALBUM_PHOTO", "EVENT_PHOTO"];

function savePhotos(post: Row, requested: { fileId: string; caption?: string }[] | undefined, userId: string, now: number) {
  const list = requested ?? [];
  const ids = list.map((p) => p.fileId);
  if (new Set(ids).size !== ids.length) throw badRequest("Одно фото добавлено в пост дважды");
  for (const id of ids) {
    const file = db.files.get(id);
    const own = !!file && file.kind === "BLOG_PHOTO" && file.uploadedById === userId;
    const fromEvent = !!file && EVENT_PHOTO_KINDS.includes(file.kind) && !!post.eventId && post.eventId === file.eventId;
    if (!own && !fromEvent) throw badRequest("Это фото нельзя добавить: подходят свои загруженные и фото этой встречи");
  }
  const old = db.blogPostPhotos.rows.filter((p) => p.postId === post.id);
  db.blogPostPhotos.removeWhere((p) => p.postId === post.id);
  list.forEach((p, i) =>
    db.blogPostPhotos.insert({ id: newId(), fileId: p.fileId, postId: post.id, caption: p.caption ?? null, position: i, createdAt: now, updatedAt: now }),
  );
  dropUnusedUploads(old, userId, new Set(ids));
}

function dropUnusedUploads(removed: Row[], authorId: string, kept: Set<string>) {
  for (const ph of removed) {
    if (kept.has(ph.fileId)) continue;
    const file = db.files.get(ph.fileId);
    if (file && file.kind === "BLOG_PHOTO" && file.uploadedById === authorId && !db.blogPostPhotos.rows.some((p) => p.fileId === file.id)) deleteFile(file);
  }
}

export function createPost(userId: string, r: PostRequest, now: number) {
  checkWriter(user(userId));
  const target = resolveTarget(r, userId, null, now);
  const publish = r.publish === true;
  const post = db.blogPosts.insert({
    id: newId(), body: r.body ?? null, type: r.type, title: (r.title ?? "").trim() || null, status: publish ? "PUBLISHED" : "DRAFT", eventId: target.eventId,
    sportId: target.sportId, authorId: userId, createdAt: now, updatedAt: now, publishedAt: publish ? now : null, widgetUserId: r.widgetUserId ?? null,
    commentsEnabled: r.commentsEnabled !== false, widgetOrganizationId: r.widgetOrganizationId ?? null,
  });
  savePhotos(post, r.photos, userId, now);
  return getPost(post.id as string, userId, now);
}

export function updatePost(postId: string, userId: string, r: PostRequest, now: number) {
  const post = visiblePost(postId, userId);
  if (!canEdit(post, userId)) throw forbidden("Править можно только свой пост");
  checkWriter(user(userId));
  const target = resolveTarget(r, userId, post.eventId ?? null, now);
  const publish = r.publish === true;
  Object.assign(post, {
    type: r.type, status: publish ? "PUBLISHED" : "DRAFT", eventId: target.eventId, sportId: target.sportId, title: (r.title ?? "").trim() || null,
    body: (r.body ?? "").trim() || null, widgetOrganizationId: r.widgetOrganizationId ?? null, widgetUserId: r.widgetUserId ?? null,
    commentsEnabled: r.commentsEnabled !== false, updatedAt: now,
  });
  if (!post.publishedAt && publish) post.publishedAt = now;
  db.blogPosts.touch();
  savePhotos(post, r.photos, userId, now);
  return getPost(postId, userId, now);
}

export function deletePost(postId: string, userId: string) {
  const post = visiblePost(postId, userId);
  if (!canDelete(post, user(userId))) throw forbidden("Удалить можно только свой пост");
  const old = db.blogPostPhotos.rows.filter((p) => p.postId === post.id);
  db.blogPostPhotos.removeWhere((p) => p.postId === post.id);
  db.blogPostLikes.removeWhere((l) => l.postId === post.id);
  db.blogComments.removeWhere((c) => c.postId === post.id);
  db.blogPosts.remove(post.id as string);
  dropUnusedUploads(old, post.authorId, new Set());
}

export function likePost(postId: string, userId: string, like: boolean, now: number) {
  const post = visiblePost(postId, userId);
  if (like) {
    const reason = likeBlockedReason(post, user(userId));
    if (reason) throw conflict(reason);
    if (!db.blogPostLikes.find((l) => l.postId === postId && l.userId === userId)) db.blogPostLikes.insert({ id: newId(), postId, userId, createdAt: now, updatedAt: now });
  } else {
    const existing = db.blogPostLikes.find((l) => l.postId === postId && l.userId === userId);
    if (existing) db.blogPostLikes.remove(existing.id as string);
  }
  return { likesCount: db.blogPostLikes.rows.filter((l) => l.postId === postId).length, likedByMe: like };
}

export async function uploadBlogPhoto(userId: string, form: FormData | null, now: number) {
  checkWriter(user(userId));
  return fileResponse(await storeUpload("BLOG_PHOTO", formFile(form), userId, null, null, null, now));
}

// ---------- вспомогательные выборки ----------

export function eligibleEvents(userId: string, now: number) {
  const list = db.events.rows
    .filter((e) => e.status !== "DELETED" && e.startAt <= now && (isOrganizer(e, userId) || registrationOf(e.id as string, userId)?.status === "CONFIRMED"))
    .sort((a, b) => b.startAt - a.startAt)
    .slice(0, 50);
  const byId = blogEvents(list);
  return list.map((e) => byId.get(e.id as string));
}

export function eventPhotos(eventId: string, userId: string) {
  const event = db.events.get(eventId);
  if (!event) throw notFound(EVENT_NOT_FOUND);
  const denied = reportForbiddenReason(event, userId);
  if (denied) throw forbidden(denied);
  return db.files.rows
    .filter((f) => f.eventId === eventId && EVENT_PHOTO_KINDS.includes(f.kind))
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .map(fileResponse);
}

/** «Как прошла встреча?»: последняя закончившаяся за неделю встреча, где я был и о которой ещё не писал. */
export function prompt(userId: string, now: number) {
  if (user(userId).systemRole === "ADMIN") return null;
  const from = now - 7 * DAY;
  const endOf = (o: Row) => o.endAt ?? o.startAt;
  const finished = db.eventOccurrences.rows
    .filter((o) => {
      if (o.status !== "SCHEDULED" || endOf(o) > now || endOf(o) < from) return false;
      const e = db.events.get(o.eventId);
      return !!e && e.status !== "DELETED" && (e.authorId === userId || isOrganizer(e, userId) || registrationOf(e.id as string, userId)?.status === "CONFIRMED");
    })
    .sort((a, b) => endOf(b) - endOf(a) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 20);
  const written = new Set(db.blogPosts.rows.filter((p) => p.authorId === userId && p.eventId).map((p) => p.eventId as string));
  const occurrence = finished.find((o) => !written.has(o.eventId));
  const event = occurrence && db.events.get(occurrence.eventId);
  if (!occurrence || !event) return null;
  const files = db.files.rows
    .filter((f) => f.eventId === event.id && EVENT_PHOTO_KINDS.includes(f.kind))
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  return {
    event: blogEvents([event]).get(event.id as string), endedAt: iso(occurrence.endAt ?? occurrence.startAt),
    photos: files.slice(0, PROMPT_PHOTOS).map(fileResponse), photosCount: files.length,
  };
}

/** «Авторы недели»: больше всех публиковали за последний месяц. */
export function topAuthors(limit: number, now: number) {
  const from = now - 30 * DAY;
  const counts = new Map<string, number>();
  for (const p of db.blogPosts.rows) if (p.status === "PUBLISHED" && p.publishedAt >= from) counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.min(Math.max(limit, 1), 10));
  return top
    .filter(([id]) => db.users.get(id))
    .map(([id]) => ({
      author: userShort(db.users.get(id)), organization: orgShort(organizationOfAccount(id)),
      postsCount: db.blogPosts.rows.filter((p) => p.status === "PUBLISHED" && p.authorId === id).length,
    }));
}

// ---------- комментарии ----------

function commentResponses(post: Row, page: Row[], userId: string) {
  return page.map((comment) => {
    const parent = comment.parentId ? db.blogComments.get(comment.parentId) : undefined;
    const deleted = !!comment.deletedAt;
    let replyText = parent && !parent.deletedAt ? parent.text : null;
    if (replyText && replyText.length > QUOTE_LENGTH) replyText = `${replyText.slice(0, QUOTE_LENGTH).trimEnd()}…`;
    return {
      id: comment.id, author: userShort(db.users.get(comment.authorId)), organization: orgShort(organizationOfAccount(comment.authorId)),
      isPostAuthor: comment.authorId === post.authorId, text: deleted ? null : comment.text, createdAt: iso(comment.createdAt), editedAt: iso(comment.editedAt),
      deleted, replyTo: parent ? { id: parent.id, author: userShort(db.users.get(parent.authorId)), text: replyText, deleted: !!parent.deletedAt } : null,
      isMine: comment.authorId === userId, canEdit: commentEditBlockedReason(comment, userId) === null,
    };
  });
}

export function listBlogComments(postId: string, userId: string) {
  const post = visiblePost(postId, userId);
  return commentResponses(post, db.blogComments.rows.filter((c) => c.postId === postId).sort((a, b) => a.createdAt - b.createdAt), userId);
}

export function addBlogComment(postId: string, userId: string, text: string, replyToId: string | undefined, now: number) {
  const post = visiblePost(postId, userId);
  let reason: string | null;
  if (!replyToId) reason = commentBlockedReason(post);
  else {
    const parent = db.blogComments.get(replyToId);
    if (!parent || parent.postId !== postId) throw badRequest("Комментарий, на который вы отвечаете, не найден");
    reason = replyBlockedReason(post, parent);
  }
  if (reason) throw conflict(reason);
  const saved = db.blogComments.insert({ id: newId(), text, postId, authorId: userId, editedAt: null, parentId: replyToId ?? null, createdAt: now, deletedAt: null, updatedAt: now });
  return commentResponses(post, [saved], userId)[0];
}

function editableComment(post: Row, commentId: string, userId: string): Row {
  const comment = db.blogComments.get(commentId);
  if (!comment || comment.postId !== post.id) throw notFound(COMMENT_NOT_FOUND);
  const reason = commentEditBlockedReason(comment, userId);
  if (reason) throw comment.authorId === userId ? conflict(reason) : forbidden(reason);
  return comment;
}

export function updateBlogComment(postId: string, commentId: string, userId: string, text: string, now: number) {
  const post = visiblePost(postId, userId);
  const comment = editableComment(post, commentId, userId);
  Object.assign(comment, { text, editedAt: now, updatedAt: now });
  db.blogComments.touch();
  return commentResponses(post, [comment], userId)[0];
}

export function deleteBlogComment(postId: string, commentId: string, userId: string, now: number) {
  const post = visiblePost(postId, userId);
  const comment = editableComment(post, commentId, userId);
  Object.assign(comment, { deletedAt: now, updatedAt: now });
  db.blogComments.touch();
}

