// events, occurrences, registrations, comments
import { check, defineHandlers, pageParams, requireBody } from "../http";
import {
  acceptInvitation, addPhoto, announce, calendarIcs, clearAnnouncement, createEvent, createPermission, declineInvitation,
  getEvent, inviteOrganizer, listEvents, mapEvents, mineEvents, myInvitations, removeOrganizer, removePhoto, setPhotoFocus, updateEvent,
} from "../services/events";
import { createComment, deleteComment, listComments, updateComment } from "../services/comments";
import {
  addOccurrence, attend, attendees, cancelOccurrence, confirmOccurrence, listOccurrences, rescheduleOccurrence, unattend,
} from "../services/occurrences";
import {
  approveRegistration, cancelRegistration, createRegistration, listForEvent, myRegistrations, rejectRegistration,
} from "../services/registrations";

const instant = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};

defineHandlers({
  // ---------- мероприятия ----------
  events_list: (ctx) => {
    const q = ctx.query;
    return listEvents(
      {
        searchText: q.str("searchText"), sportId: q.str("sportId"), from: instant(q.str("from")), to: instant(q.str("to")),
        level: q.str("level"), joinMode: q.str("joinMode"), format: q.str("format"), organizationId: q.str("organizationId"),
        forMe: q.bool("forMe"), lat: q.num("lat"), lon: q.num("lon"), radiusKm: q.int("radiusKm"), page: q.int("page"), size: q.int("size"),
      },
      ctx.me().id as string,
      ctx.now,
    );
  },

  events_map: (ctx) => {
    const q = ctx.query;
    return mapEvents(
      {
        minLon: q.num("minLon") ?? 0, minLat: q.num("minLat") ?? 0, maxLon: q.num("maxLon") ?? 0, maxLat: q.num("maxLat") ?? 0,
        from: instant(q.str("from")), to: instant(q.str("to")), searchText: q.str("searchText"), sportId: q.str("sportId"),
        level: q.str("level"), joinMode: q.str("joinMode"), forMe: q.bool("forMe"), organizationId: q.str("organizationId"),
        mine: q.bool("mine"), lat: q.num("lat"), lon: q.num("lon"), radiusKm: q.int("radiusKm"),
      },
      ctx.me().id as string,
      ctx.now,
    );
  },

  events_mine: (ctx) => {
    const { page, size } = pageParams(ctx.query);
    return mineEvents(ctx.me().id as string, ctx.query.str("status"), ctx.query.str("when"), ctx.query.str("searchText"), page ?? 0, size ?? 20, ctx.now);
  },

  events_organizerInvitations: (ctx) => myInvitations(ctx.me().id as string),
  events_createPermission: (ctx) => createPermission(ctx.me().id as string),
  events_get: (ctx) => getEvent(ctx.params.id, ctx.me().id as string, ctx.now),
  events_create: (ctx) => createEvent(ctx.me().id as string, requireBody(ctx), ctx.now),
  events_update: (ctx) => updateEvent(ctx.params.id, ctx.me().id as string, requireBody(ctx), ctx.now),
  events_announce: (ctx) => {
    const body = requireBody(ctx);
    check(body, { text: { required: true, max: 1000 } });
    return announce(ctx.params.id, ctx.me().id as string, body.text, ctx.now);
  },
  events_clearAnnouncement: (ctx) => clearAnnouncement(ctx.params.id, ctx.me().id as string, ctx.now),
  events_calendar: (ctx) => calendarIcs(ctx.params.id, ctx.me().id as string, ctx.now),

  events_addOrganizer: (ctx) => {
    const body = requireBody(ctx);
    check(body, { login: { required: true } });
    return inviteOrganizer(ctx.params.id, ctx.me().id as string, body.login, ctx.now);
  },
  events_acceptOrganizerInvite: (ctx) => acceptInvitation(ctx.params.id, ctx.me().id as string, ctx.now),
  events_declineOrganizerInvite: (ctx) => declineInvitation(ctx.params.id, ctx.me().id as string, ctx.now),
  events_removeOrganizer: (ctx) => removeOrganizer(ctx.params.id, ctx.me().id as string, ctx.params.userId, ctx.now),

  events_addPhoto: (ctx) => addPhoto(ctx.params.id, ctx.me().id as string, ctx.form, ctx.query, ctx.now),
  events_removePhoto: (ctx) => removePhoto(ctx.params.id, ctx.params.fileId, ctx.me().id as string, ctx.now),
  events_setPhotoFocus: (ctx) => setPhotoFocus(ctx.params.id, ctx.params.fileId, ctx.me().id as string, ctx.body, ctx.now),

  // ---------- занятия ----------
  occurrences_list: (ctx) =>
    listOccurrences(ctx.params.id, ctx.me().id as string, instant(ctx.query.str("from")), instant(ctx.query.str("to")), ctx.now),
  occurrences_attend: (ctx) => attend(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string, ctx.now),
  occurrences_unattend: (ctx) => unattend(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string, ctx.now),
  occurrences_add: (ctx) => {
    const body = requireBody(ctx);
    check(body, { startAt: { required: true } });
    return addOccurrence(ctx.params.id, ctx.me().id as string, Date.parse(body.startAt), body.endAt ? Date.parse(body.endAt) : null, ctx.now);
  },
  occurrences_reschedule: (ctx) => {
    const body = requireBody(ctx);
    check(body, { startAt: { required: true } });
    return rescheduleOccurrence(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string, Date.parse(body.startAt), body.endAt ? Date.parse(body.endAt) : null, ctx.now);
  },
  occurrences_cancel: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return cancelOccurrence(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string, body.reason, ctx.now);
  },
  occurrences_confirm: (ctx) => confirmOccurrence(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string, ctx.now),
  occurrences_attendees: (ctx) => attendees(ctx.params.id, ctx.params.occurrenceId, ctx.me().id as string),

  // ---------- записи ----------
  registrations_create: (ctx) => createRegistration(ctx.params.id, ctx.me().id as string, ctx.body?.message, ctx.now),
  registrations_cancel: (ctx) => cancelRegistration(ctx.params.id, ctx.me().id as string, ctx.now),
  registrations_listForEvent: (ctx) => listForEvent(ctx.params.id, ctx.me().id as string, ctx.query.str("status")),
  registrations_approve: (ctx) => approveRegistration(ctx.params.id, ctx.me().id as string, ctx.now),
  registrations_reject: (ctx) => rejectRegistration(ctx.params.id, ctx.me().id as string, ctx.body?.reason ?? null, ctx.now),
  registrations_mine: (ctx) => {
    const { page, size } = pageParams(ctx.query);
    return myRegistrations(ctx.me().id as string, ctx.query.str("status"), ctx.query.str("when"), page ?? 0, size ?? 20, ctx.now);
  },

  // ---------- обсуждение ----------
  comments_list: (ctx) => listComments(ctx.params.id, ctx.me().id as string, instant(ctx.query.str("after"))),
  comments_create: (ctx) => {
    const body = requireBody(ctx);
    check(body, { text: { required: true, max: 2000 } });
    return createComment(ctx.params.id, ctx.me().id as string, body.text, body.replyToId, ctx.now);
  },
  comments_update: (ctx) => {
    const body = requireBody(ctx);
    check(body, { text: { required: true, max: 2000 } });
    return updateComment(ctx.params.id, ctx.params.commentId, ctx.me().id as string, body.text, ctx.now);
  },
  comments_delete: (ctx) => {
    deleteComment(ctx.params.id, ctx.params.commentId, ctx.me().id as string, ctx.now);
  },
});

