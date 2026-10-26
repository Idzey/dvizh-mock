// admin: дашборд, мероприятия, пользователи, организации, модерация, виды спорта, награды, вещи бобра
import { check, defineHandlers, requireBody } from "../http";
import {
  adminApproveSport, adminCreateSport, adminDelete, adminDeletePetItem, adminDeleteSport, adminHideSport, adminImportPetItem, adminListEvents,
  adminListModeration, adminListPetItems, adminListSports, adminListUsers, adminMergeSport, adminRemoveSportImage, adminRenameSport, adminReplaceSportImage,
  adminRestore, adminRestoreSport, adminSportCounts, adminStats, adminUnpublish, adminUpdatePetItemFit, approveModeration, clearProfileText,
  hideModeration, recheckModeration,
} from "../services/admin";
import { hideComment, unhideComment } from "../services/comments";
import { adminApprove, adminGetOrganization, adminListOrganizations, adminReject, adminReturn } from "../services/organizations";
import { confirmAward, forAdmin } from "../services/org-awards";

defineHandlers({
  admin_stats: (ctx) => adminStats(ctx.query.int("days", 30) ?? 30, ctx.now),
  admin_listEvents: (ctx) => {
    const q = ctx.query;
    return adminListEvents(q.str("status"), q.str("organizationId"), q.str("authorId"), q.str("searchText"), q.int("page", 0) ?? 0, q.int("size", 20) ?? 20);
  },
  admin_unpublishEvent: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return adminUnpublish(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },
  admin_restoreEvent: (ctx) => adminRestore(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_deleteEvent: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return adminDelete(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },
  admin_hideComment: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return hideComment(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },
  admin_unhideComment: (ctx) => unhideComment(ctx.params.id, ctx.me().id as string, ctx.now),

  admin_listUsers: (ctx) => adminListUsers(ctx.query.str("searchText"), ctx.query.str("role"), ctx.query.int("page", 0) ?? 0, ctx.query.int("size", 20) ?? 20),

  admin_listOrganizations: (ctx) =>
    adminListOrganizations(ctx.query.str("status"), ctx.query.str("searchText"), ctx.query.int("page", 0) ?? 0, ctx.query.int("size", 20) ?? 20),
  admin_getOrganization: (ctx) => adminGetOrganization(ctx.params.id),
  admin_approveOrganization: (ctx) => adminApprove(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_rejectOrganization: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return adminReject(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },
  admin_returnOrganization: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return adminReturn(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },

  admin_listModeration: (ctx) => adminListModeration(ctx.query.str("status"), ctx.query.str("targetType"), ctx.query.int("page", 0) ?? 0, ctx.query.int("size", 20) ?? 20),
  admin_approveModeration: (ctx) => approveModeration(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_hideModeration: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true, max: 500 } });
    return hideModeration(ctx.params.id, ctx.me().id as string, body.reason, ctx.now);
  },
  admin_clearProfileText: (ctx) => clearProfileText(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_recheckModeration: () => recheckModeration(),

  admin_listSports: (ctx) => {
    const q = ctx.query;
    return adminListSports(q.all("status"), q.bool("withoutImage"), q.str("searchText"), q.int("page", 0) ?? 0, q.int("size", 20) ?? 20);
  },
  admin_sportCounts: () => adminSportCounts(),
  admin_createSport: (ctx) => adminCreateSport(ctx.me().id as string, ctx.query.str("name") ?? "", ctx.form, ctx.query.num("focusX"), ctx.query.num("focusY"), ctx.query.bool("published") ?? true, ctx.now),
  admin_renameSport: (ctx) => {
    const body = requireBody(ctx);
    check(body, { name: { required: true, max: 100 } });
    return adminRenameSport(ctx.params.id, body.name);
  },
  admin_replaceSportImage: (ctx) => adminReplaceSportImage(ctx.params.id, ctx.me().id as string, ctx.form, ctx.query.num("focusX"), ctx.query.num("focusY"), ctx.now),
  admin_removeSportImage: (ctx) => adminRemoveSportImage(ctx.params.id),
  admin_approveSport: (ctx) => adminApproveSport(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_hideSport: (ctx) => adminHideSport(ctx.params.id, ctx.me().id as string, ctx.body?.reason, ctx.now),
  admin_restoreSport: (ctx) => adminRestoreSport(ctx.params.id, ctx.me().id as string, ctx.now),
  admin_mergeSport: (ctx) => {
    const body = requireBody(ctx);
    check(body, { targetId: { required: true } });
    return adminMergeSport(ctx.params.id, body.targetId, body.reason, ctx.me().id as string, ctx.now);
  },
  admin_deleteSport: (ctx) => {
    adminDeleteSport(ctx.params.id);
  },

  admin_listAwards: (ctx) => forAdmin(ctx.query.str("month") ? `${ctx.query.str("month")}-01`.replace(/-01-01$/, "-01") : undefined, ctx.now),
  admin_confirmAward: (ctx) => confirmAward(ctx.params.id, ctx.me().id as string, ctx.now),

  admin_listPetItems: () => adminListPetItems(),
  admin_previewPetItem: () => adminImportPetItem(),
  admin_createPetItem: () => adminImportPetItem(),
  admin_updatePetItemFit: (ctx) => {
    const body = requireBody(ctx);
    check(body, { x: { notNull: true }, y: { notNull: true }, scale: { notNull: true } });
    return adminUpdatePetItemFit(ctx.params.code, body);
  },
  admin_deletePetItem: (ctx) => {
    adminDeletePetItem(ctx.params.code);
  },
});
