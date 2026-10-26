// Обсуждение под мероприятием как чат (порт CommentService и AdminCommentService).
import { db, type Row } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../http";
import { isMainAccount, schedule } from "../life/jobs";
import { newId } from "../util/ids";
import { iso, orgShort, organizationOfAccount, userShort } from "./common";
import { publish } from "./notify";
import { requireCleanComment, resolve as resolveModeration, submit as submitModeration, withdraw } from "./moderation";
import { EVENT_NOT_FOUND } from "./occurrences";
import { commentBlockedReason, commentEditBlockedReason, organizerIds, replyBlockedReason } from "./policy";

export const COMMENT_NOT_FOUND = "Сообщение не найдено";
const QUOTE_LENGTH = 140;

const findEvent = (id: string): Row => {
  const e = db.events.get(id);
  if (!e) throw notFound(EVENT_NOT_FOUND);
  return e;
};

const visibleText = (c: Row) => (c.deletedAt ? null : c.text);
const publicText = (c: Row) => (c.hidden ? null : visibleText(c));
function quote(c: Row) {
  const text = publicText(c);
  if (text === null || text.length <= QUOTE_LENGTH) return text;
  return `${text.slice(0, QUOTE_LENGTH).trimEnd()}…`;
}
const preview = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 200).trimEnd()}…`);

/** Авторы, цитаты, счётчики ответов и организации авторов — за один проход. */
export function commentResponses(event: Row, page: Row[], userId: string) {
  if (!page.length) return [];
  const admin = db.users.get(userId)?.systemRole === "ADMIN";
  const organizers = organizerIds(event);
  const ids = new Set(page.map((c) => c.id as string));
  const replies = new Map<string, number>();
  for (const c of db.comments.rows) if (c.parentId && ids.has(c.parentId)) replies.set(c.parentId, (replies.get(c.parentId) ?? 0) + 1);
  return page.map((comment) => {
    const parent = comment.parentId ? db.comments.get(comment.parentId) : undefined;
    const mine = comment.authorId === userId;
    const check = admin ? db.moderationChecks.find((m) => m.targetType === "COMMENT" && m.targetId === comment.id) : undefined;
    return {
      id: comment.id,
      author: userShort(db.users.get(comment.authorId)),
      organization: orgShort(organizationOfAccount(comment.authorId)),
      text: admin ? visibleText(comment) : publicText(comment),
      isOrganizer: organizers.has(comment.authorId),
      isMine: mine,
      canEdit: commentEditBlockedReason(event, comment, userId) === null,
      replyTo: parent
        ? { id: parent.id, author: userShort(db.users.get(parent.authorId)), text: quote(parent), deleted: !!parent.deletedAt, hidden: !!parent.hidden }
        : null,
      repliesCount: replies.get(comment.id as string) ?? 0,
      createdAt: iso(comment.createdAt),
      editedAt: iso(comment.editedAt),
      deleted: !!comment.deletedAt,
      hidden: !!comment.hidden,
      hiddenReason: admin || mine ? (comment.hideReason ?? null) : null,
      moderation: check
        ? { checkId: check.id, status: check.status, categories: check.categories ?? [], severity: check.severity, explanation: check.explanation ?? null }
        : null,
    };
  });
}

/** Старые сверху, как в переписке. after — только новое и изменённое после этого момента. */
export function listComments(eventId: string, userId: string, after: number | undefined) {
  const event = findEvent(eventId);
  const rows = db.comments.rows
    .filter((c) => c.eventId === eventId && (after === undefined || c.createdAt > after || c.updatedAt > after))
    .sort((a, b) => a.createdAt - b.createdAt);
  return commentResponses(event, rows, userId);
}

export function createComment(eventId: string, userId: string, text: string, replyToId: string | null | undefined, now: number) {
  const event = findEvent(eventId);
  let blocked: string | null;
  let parent: Row | undefined;
  if (!replyToId) blocked = commentBlockedReason(event);
  else {
    parent = db.comments.get(replyToId);
    if (!parent || parent.eventId !== eventId) throw badRequest("Сообщение, на которое вы отвечаете, не найдено");
    blocked = replyBlockedReason(event, parent);
  }
  if (blocked) throw conflict(blocked);
  requireCleanComment(text);
  const saved = db.comments.insert({
    id: newId(), text, hidden: false, eventId, authorId: userId, editedAt: null, hiddenAt: null, parentId: replyToId ?? null,
    createdAt: now, deletedAt: null, updatedAt: now, hiddenById: null, hideReason: null,
  });
  submitModeration("COMMENT", saved.id, eventId, userId, saved.text, now);
  const organizers = organizerIds(event);
  if (parent) {
    publish([{
      key: `reply:${saved.id}`, recipients: [parent.authorId], actorId: userId, type: "COMMENT_REPLY", category: "DISCUSSIONS",
      title: "Вам ответили в обсуждении", body: `${event.title}\n${preview(saved.text)}`, targetPath: `/events/${eventId}`, eventId,
    }], now);
  } else if (!organizers.has(userId)) {
    // «живой мир»: на вопрос отвечает организатор из массовых аккаунтов
    if (!isMainAccount(event.authorId)) schedule("reply-comment", 20_000, { commentId: saved.id });
    publish([{
      key: `question:${saved.id}`, recipients: organizers, actorId: userId, type: "COMMENT_CREATED", category: "DISCUSSIONS",
      title: "Новый вопрос в обсуждении", body: `${event.title}\n${preview(saved.text)}`, targetPath: `/events/${eventId}`, eventId,
    }], now);
  }
  return commentResponses(event, [saved], userId)[0];
}

/** Чужое — 403, удалённое или закрытое обсуждение — 409. */
function editable(event: Row, commentId: string, userId: string): Row {
  const comment = db.comments.get(commentId);
  if (!comment || comment.eventId !== event.id) throw notFound(COMMENT_NOT_FOUND);
  const blocked = commentEditBlockedReason(event, comment, userId);
  if (blocked) throw comment.authorId === userId ? conflict(blocked) : forbidden(blocked);
  return comment;
}

export function updateComment(eventId: string, commentId: string, userId: string, text: string, now: number) {
  const event = findEvent(eventId);
  const comment = editable(event, commentId, userId);
  requireCleanComment(text);
  Object.assign(comment, { text, editedAt: now, updatedAt: now });
  db.comments.touch();
  submitModeration("COMMENT", comment.id, eventId, userId, comment.text, now);
  return commentResponses(event, [comment], userId)[0];
}

export function deleteComment(eventId: string, commentId: string, userId: string, now: number) {
  const event = findEvent(eventId);
  const comment = editable(event, commentId, userId);
  Object.assign(comment, { deletedAt: now, updatedAt: now });
  db.comments.touch();
  withdraw("COMMENT", commentId);
}

// ---------- модерация администратором ----------

function findComment(id: string): Row {
  const c = db.comments.get(id);
  if (!c) throw notFound(COMMENT_NOT_FOUND);
  return c;
}

export function hideComment(commentId: string, adminId: string, reason: string, now: number) {
  const comment = findComment(commentId);
  const event = findEvent(comment.eventId);
  Object.assign(comment, { hidden: true, hiddenAt: now, hiddenById: adminId, hideReason: reason, updatedAt: now });
  db.comments.touch();
  publish([{
    key: `hidden:${comment.id}:${now}`, recipients: [comment.authorId], actorId: adminId, type: "COMMENT_HIDDEN", category: "DISCUSSIONS",
    title: "Ваше сообщение скрыто модератором", body: `${event.title}\nПричина: ${reason}`, targetPath: `/events/${event.id}`, eventId: event.id as string,
  }], now);
  resolveModeration("COMMENT", commentId, "HIDDEN", adminId, now);
  return commentResponses(event, [comment], adminId)[0];
}

export function unhideComment(commentId: string, adminId: string, now: number) {
  const comment = findComment(commentId);
  const event = findEvent(comment.eventId);
  if (comment.hidden) {
    Object.assign(comment, { hidden: false, hiddenAt: null, hiddenById: null, hideReason: null, updatedAt: now });
    db.comments.touch();
    resolveModeration("COMMENT", commentId, "APPROVED", adminId, now);
  }
  return commentResponses(event, [comment], adminId)[0];
}
