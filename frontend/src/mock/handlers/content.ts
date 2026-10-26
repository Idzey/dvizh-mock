// organizations, blog, recommendations
import { check, defineHandlers, pageParams, requireBody } from "../http";
import {
  addBlogComment, createPost, deleteBlogComment, deletePost, eligibleEvents, eventPhotos, getPost, likePost, listBlogComments, listPosts, minePosts,
  prompt, topAuthors, updateBlogComment, updatePost, uploadBlogPhoto,
} from "../services/blog";
import {
  addDocument, catalog, changeSubscription, cities, deleteLogo, featuredOrganization, myOrganization, orgPhotos, overview, pastMeetings, publicOrganization,
  removeDocument, saveMyOrganization, uploadLogo,
} from "../services/organizations";
import { dismiss, explain, recommendedEvents, recommendedOrganizations, similarEvents, undismiss } from "../services/recommendations";

const instant = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};

defineHandlers({
  // ---------- организации ----------
  organizations_list: (ctx) => {
    const q = ctx.query;
    return catalog(ctx.me().id as string, q.str("searchText"), q.str("city"), q.str("sportId"), q.bool("mine") ?? false, q.int("page", 0) ?? 0, q.int("size", 12) ?? 12, ctx.now);
  },
  organizations_cities: () => cities(),
  organizations_featured: (ctx) => featuredOrganization(ctx.now),
  organizations_get: (ctx) => publicOrganization(ctx.params.id, ctx.now),
  organizations_overview: (ctx) => overview(ctx.params.id, ctx.me().id as string, ctx.now),
  organizations_pastMeetings: (ctx) => pastMeetings(ctx.params.id, ctx.me().id as string, ctx.query.str("sportId"), ctx.query.int("page", 0) ?? 0, ctx.query.int("size", 4) ?? 4, ctx.now),
  organizations_photos: (ctx) => orgPhotos(ctx.params.id, ctx.query.int("page", 0) ?? 0, ctx.query.int("size", 24) ?? 24),
  organizations_subscribe: (ctx) => changeSubscription(ctx.params.id, ctx.me().id as string, true, ctx.now),
  organizations_unsubscribe: (ctx) => changeSubscription(ctx.params.id, ctx.me().id as string, false, ctx.now),
  organizations_me: (ctx) => myOrganization(ctx.me().id as string),
  organizations_saveMine: (ctx) => {
    const body = requireBody(ctx);
    check(body, { name: { required: true, max: 200 }, description: { required: true, max: 5000 }, city: { max: 100 }, contacts: { notEmpty: true } });
    return saveMyOrganization(ctx.me().id as string, body, ctx.now);
  },
  organizations_uploadLogo: (ctx) => uploadLogo(ctx.me().id as string, ctx.form, ctx.now),
  organizations_deleteLogo: (ctx) => deleteLogo(ctx.me().id as string),
  organizations_addDocument: (ctx) => addDocument(ctx.me().id as string, ctx.form, ctx.now),
  organizations_removeDocument: (ctx) => removeDocument(ctx.me().id as string, ctx.params.fileId),

  // ---------- блог ----------
  blog_list: (ctx) => {
    const q = ctx.query;
    return listPosts(
      { type: q.str("type"), sportId: q.str("sportId"), authorId: q.str("authorId"), eventId: q.str("eventId"), organizationId: q.str("organizationId"), searchText: q.str("searchText") },
      q.int("page", 0) ?? 0, q.int("size", 20) ?? 20, ctx.me().id as string,
    );
  },
  blog_mine: (ctx) => {
    const { page, size } = pageParams(ctx.query);
    return minePosts(ctx.me().id as string, ctx.query.str("status"), page ?? 0, size ?? 20);
  },
  blog_get: (ctx) => getPost(ctx.params.id, ctx.me().id as string, ctx.now),
  blog_create: (ctx) => {
    const body = requireBody(ctx);
    check(body, { type: { required: true }, title: { max: 200 } });
    return createPost(ctx.me().id as string, body, ctx.now);
  },
  blog_update: (ctx) => updatePost(ctx.params.id, ctx.me().id as string, requireBody(ctx), ctx.now),
  blog_delete: (ctx) => {
    deletePost(ctx.params.id, ctx.me().id as string);
  },
  blog_like: (ctx) => likePost(ctx.params.id, ctx.me().id as string, true, ctx.now),
  blog_unlike: (ctx) => likePost(ctx.params.id, ctx.me().id as string, false, ctx.now),
  blog_uploadPhoto: (ctx) => uploadBlogPhoto(ctx.me().id as string, ctx.form, ctx.now),
  blog_eligibleEvents: (ctx) => eligibleEvents(ctx.me().id as string, ctx.now),
  blog_eventPhotos: (ctx) => eventPhotos(ctx.params.eventId, ctx.me().id as string),
  blog_prompt: (ctx) => prompt(ctx.me().id as string, ctx.now),
  blog_topAuthors: (ctx) => topAuthors(ctx.query.int("limit", 3) ?? 3, ctx.now),
  blog_comments: (ctx) => listBlogComments(ctx.params.id, ctx.me().id as string),
  blog_addComment: (ctx) => {
    const body = requireBody(ctx);
    check(body, { text: { required: true, max: 2000 } });
    return addBlogComment(ctx.params.id, ctx.me().id as string, body.text, body.replyToId, ctx.now);
  },
  blog_updateComment: (ctx) => {
    const body = requireBody(ctx);
    check(body, { text: { required: true, max: 2000 } });
    return updateBlogComment(ctx.params.id, ctx.params.commentId, ctx.me().id as string, body.text, ctx.now);
  },
  blog_deleteComment: (ctx) => {
    deleteBlogComment(ctx.params.id, ctx.params.commentId, ctx.me().id as string, ctx.now);
  },

  // ---------- рекомендации ----------
  recommendations_events: (ctx) => {
    const q = ctx.query;
    return recommendedEvents(
      ctx.me().id as string,
      { lat: q.num("lat"), lon: q.num("lon"), radiusKm: q.num("radiusKm"), sportId: q.str("sportId"), from: instant(q.str("from")), to: instant(q.str("to")), page: q.int("page"), size: q.int("size") },
      ctx.now,
    );
  },
  recommendations_organizations: (ctx) => recommendedOrganizations(ctx.me().id as string, ctx.query.num("lat"), ctx.query.num("lon"), ctx.query.int("limit", 6) ?? 6, ctx.now),
  recommendations_explain: (ctx) => {
    const q = ctx.query;
    return explain(ctx.me().id as string, ctx.params.eventId, { lat: q.num("lat"), lon: q.num("lon"), radiusKm: q.num("radiusKm"), sportId: q.str("sportId"), from: instant(q.str("from")), to: instant(q.str("to")) }, ctx.now);
  },
  recommendations_dismiss: (ctx) => {
    const body = requireBody(ctx);
    check(body, { reason: { required: true } });
    dismiss(ctx.me().id as string, ctx.params.eventId, body.reason, ctx.now);
  },
  recommendations_undismiss: (ctx) => {
    undismiss(ctx.me().id as string, ctx.params.eventId);
  },
  events_similar: (ctx) => similarEvents(ctx.params.id, ctx.me().id as string, ctx.query.int("limit", 6) ?? 6, ctx.now),
});
