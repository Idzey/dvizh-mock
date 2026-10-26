// users, pets, sports, notifications, files
import { check, defineHandlers, notFound, notImplemented, pageParams, requireBody } from "../http";
import { albumFolders, albumPhotos, addAlbumPhoto, captionAlbumPhoto, eligibleEvents, removeAlbumPhoto } from "../services/album";
import { achievementsOf, wallet } from "../services/economy";
import { cancelReminder, dismissTip, leaveTip, setReminder } from "../services/leave-tip";
import {
  connectEmail, connectMax, disconnectEmail, disconnectMax, listNotifications, pollNotifications, readAllNotifications, readNotification,
  saveSettings, settingsResponse, unreadCounts,
} from "../services/notifications";
import {
  bundles, buyBundle, buyItem, buySet, catalogResponse, cheerPet, deleteLook, equipPet, getPet, getPublicPet, renamePet, savePet, saveLook,
  savedLooks, shop,
} from "../services/pets";
import { searchSports } from "../services/sports";
import {
  addUserPhoto, deleteAvatar, getPreferences, history, historySummary, myPhotos, publicUser, removeUserPhoto, resolveUserRef, saveUserSports,
  savePreferences, updateProfile, uploadAvatar, userSportsOf,
} from "../services/users";

const instant = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};

defineHandlers({
  // ---------- профиль ----------
  users_get: (ctx) => publicUser(resolveUserRef(ctx.params.id), ctx.me().id as string, ctx.now),
  users_updateMe: (ctx) => {
    const body = requireBody(ctx);
    check(body, { firstName: { required: true, min: 2, max: 100 }, lastName: { required: true, min: 2, max: 100 }, city: { max: 100 }, bio: { max: 1000 } });
    return updateProfile(ctx.me().id as string, body, ctx.now);
  },
  users_uploadAvatar: (ctx) => uploadAvatar(ctx.me().id as string, ctx.form, ctx.now),
  users_deleteAvatar: (ctx) => deleteAvatar(ctx.me().id as string, ctx.now),
  users_myPhotos: (ctx) => myPhotos(ctx.me().id as string),
  users_addPhoto: (ctx) => addUserPhoto(ctx.me().id as string, ctx.form, ctx.now),
  users_removePhoto: (ctx) => removeUserPhoto(ctx.me().id as string, ctx.params.fileId),

  users_mySports: (ctx) => userSportsOf(ctx.me().id as string),
  users_saveMySports: (ctx) => saveUserSports(ctx.me().id as string, requireBody(ctx).sports ?? [], ctx.now),
  users_myPreferences: (ctx) => getPreferences(ctx.me().id as string),
  users_saveMyPreferences: (ctx) => savePreferences(ctx.me().id as string, requireBody(ctx), ctx.now),

  users_wallet: (ctx) => wallet(ctx.me().id as string, ctx.now),
  users_achievements: (ctx) => achievementsOf(ctx.me().id as string),
  users_userAchievements: (ctx) => achievementsOf(resolveUserRef(ctx.params.id)),
  users_history: (ctx) => {
    const { page, size } = pageParams(ctx.query);
    return history(ctx.me().id as string, ctx.query.str("sportId"), instant(ctx.query.str("from")), instant(ctx.query.str("to")), page ?? 0, size ?? 20, ctx.now);
  },
  users_historySummary: (ctx) => historySummary(ctx.me().id as string, instant(ctx.query.str("from")), instant(ctx.query.str("to")), ctx.now),

  // ---------- альбом ----------
  users_album: (ctx) => {
    const { page, size } = pageParams(ctx.query);
    return albumPhotos(resolveUserRef(ctx.params.id), ctx.me().id as string, ctx.query.str("eventId"), ctx.query.str("sportId"), ctx.query.str("sort") ?? "NEWEST", page ?? 0, size ?? 20);
  },
  users_albumFolders: (ctx) => albumFolders(resolveUserRef(ctx.params.id)),
  users_albumEligibleEvents: (ctx) => eligibleEvents(ctx.me().id as string, ctx.now),
  users_addAlbumPhoto: (ctx) => addAlbumPhoto(ctx.me().id as string, ctx.query.str("eventId"), ctx.query.str("caption"), ctx.form, ctx.now),
  users_captionAlbumPhoto: (ctx) => captionAlbumPhoto(ctx.me().id as string, ctx.params.fileId, requireBody(ctx).caption),
  users_removeAlbumPhoto: (ctx) => removeAlbumPhoto(ctx.me().id as string, ctx.params.fileId),

  // ---------- «когда выходить» ----------
  users_leaveTip: (ctx) => leaveTip(ctx.me().id as string, ctx.now),
  users_setLeaveReminder: (ctx) => {
    const body = requireBody(ctx);
    check(body, { dueAt: { required: true }, travelMode: { required: true } });
    return setReminder(ctx.me().id as string, ctx.params.occurrenceId, body, ctx.now);
  },
  users_cancelLeaveReminder: (ctx) => cancelReminder(ctx.me().id as string, ctx.params.occurrenceId, ctx.now),
  users_dismissLeaveTip: (ctx) => dismissTip(ctx.me().id as string, ctx.params.occurrenceId, ctx.now),

  // ---------- бобр ----------
  pets_getMine: (ctx) => getPet(ctx.me().id as string, ctx.now),
  pets_getUser: (ctx) => getPublicPet(resolveUserRef(ctx.params.id), ctx.now),
  pets_saveMine: (ctx) => {
    const body = requireBody(ctx);
    check(body, { activity: { required: true } });
    return savePet(ctx.me().id as string, body.activity, body.outfit ?? {}, ctx.now);
  },
  pets_rename: (ctx) => renamePet(ctx.me().id as string, requireBody(ctx).name, ctx.now),
  pets_cheer: (ctx) => cheerPet(ctx.me().id as string, ctx.now),
  pets_equip: (ctx) => equipPet(ctx.me().id as string, ctx.params.slot, ctx.body?.item ?? null, ctx.now),
  pets_catalog: () => catalogResponse(),
  pets_shop: (ctx) => shop(ctx.me().id as string),
  pets_bundles: (ctx) => bundles(ctx.me().id as string),
  pets_buy: (ctx) => buyItem(ctx.me().id as string, ctx.params.item, ctx.now),
  pets_buyBundle: (ctx) => buyBundle(ctx.me().id as string, ctx.params.code, ctx.now),
  pets_buySet: (ctx) => {
    const body = requireBody(ctx);
    return buySet(ctx.me().id as string, body.items ?? [], !!body.wear, ctx.now);
  },
  pets_looks: (ctx) => savedLooks(ctx.me().id as string),
  pets_saveLook: (ctx) => {
    const body = requireBody(ctx);
    check(body, { name: { required: true, max: 30 }, activity: { required: true } });
    return saveLook(ctx.me().id as string, body.name, body.activity, body.outfit ?? {}, ctx.now);
  },
  pets_deleteLook: (ctx) => deleteLook(ctx.me().id as string, ctx.params.id),

  // ---------- виды спорта ----------
  sports_search: (ctx) => searchSports(ctx.query.str("query")),

  // ---------- уведомления ----------
  notifications_list: (ctx) =>
    listNotifications(ctx.me().id as string, ctx.query.str("cursor"), ctx.query.int("size", 20) ?? 20, ctx.query.bool("unreadOnly") ?? false, ctx.query.all("types")),
  notifications_unreadCounts: (ctx) => unreadCounts(ctx.me().id as string),
  notifications_poll: (ctx) => pollNotifications(ctx.me().id as string, ctx.query.int("revision", 0) ?? 0),
  notifications_read: (ctx) => readNotification(ctx.me().id as string, ctx.params.id, ctx.now),
  notifications_readAll: (ctx) => readAllNotifications(ctx.me().id as string, requireBody(ctx).throughRevision, ctx.now),
  notifications_settings: (ctx) => settingsResponse(ctx.me().id as string),
  notifications_saveSettings: (ctx) => {
    const body = requireBody(ctx);
    return saveSettings(ctx.me().id as string, body.channels ?? [], body.categories ?? [], ctx.now);
  },
  notifications_connectEmail: (ctx) => {
    const body = requireBody(ctx);
    check(body, { email: { required: true, email: true } });
    return connectEmail(ctx.me().id as string, body.email, ctx.now);
  },
  notifications_disconnectEmail: (ctx) => disconnectEmail(ctx.me().id as string, ctx.now),
  notifications_connectMax: (ctx) => {
    const body = requireBody(ctx);
    check(body, { phone: { required: true } });
    return connectMax(ctx.me().id as string, body.phone, ctx.now);
  },
  notifications_disconnectMax: (ctx) => disconnectMax(ctx.me().id as string, ctx.now),
  notifications_telegram: () => ({ available: false, connected: false, username: null }),
  notifications_disconnectTelegram: () => ({ available: false, connected: false, username: null }),
  notifications_telegramLink: () => {
    throw notImplemented("В демо-версии Telegram-уведомления недоступны");
  },

  files_get: () => {
    throw notFound("Файл не найден");
  },
});

