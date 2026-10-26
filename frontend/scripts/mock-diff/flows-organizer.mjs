// Сценарии организатора и обсуждения (см. ../mock-diff.mjs).
import { DAY, png, upload } from "./util.mjs";

const MAIN = new Set(["admin", "anna", "petr", "olga", "dmitry", "elena", "sergey", "nikolai", "vika", "ladya", "enisey", "yoga", "bobry"]);
const iso = (ms) => new Date(ms).toISOString();

export default function register({ scenario, step, resetBoth, db }) {
  const userId = (username) => db.users.rows.find((u) => u.username === username).id;
  const organizerIds = (e) => new Set([e.authorId, ...db.eventOrganizers.rows.filter((o) => o.eventId === e.id).map((o) => o.userId)]);
  const isMain = (e) => MAIN.has(db.users.get(e.authorId).username);
  const later = (days, hour = 17) => {
    const d = new Date(Date.now() + days * DAY);
    d.setUTCHours(hour, 0, 0, 0);
    return d.getTime();
  };

  scenario("обсуждение", async () => {
    await resetBoth();
    const event = db.events.rows
      .filter((e) => e.status === "PUBLISHED" && !e.recurring && e.startAt > Date.now() + DAY && isMain(e) && !organizerIds(e).has(userId("anna")) && !e.organizationId)
      .sort((a, b) => a.startAt - b.startAt)[0];
    const author = db.users.get(event.authorId).username;
    const path = `/api/events/${event.id}/comments`;
    await step("список", "anna", "GET", path);
    await step("вопрос", "anna", "POST", path, { text: "Можно прийти с собакой?" }, { save: { q: "$.id" } });
    await step("ответ организатора", author, "POST", path, { text: "Конечно, на поводке", replyToId: "{q}" }, { save: { a: "$.id" } });
    await step("ответ на ответ", "anna", "POST", path, { text: "Спасибо!", replyToId: "{a}" }, { save: { b: "$.id" } });
    await step("чат", "anna", "GET", path);
    await step("правка", "anna", "PUT", `${path}/{q}`, { text: "Можно прийти с собакой? (уточнение)" });
    await step("чужая правка", "petr", "PUT", `${path}/{q}`, { text: "взлом" });
    await step("мат", "anna", "POST", path, { text: "ну ты хуй" });
    await step("замаскированный мат", "anna", "POST", path, { text: "х.у.й тебе" });
    await step("мягкое нарушение", "anna", "POST", path, { text: "Ты идиот, заработай деньги тут t.me/spamchannel пиши в лс" }, { save: { bad: "$.id" } });
    await step("очередь модерации", "admin", "GET", "/api/admin/moderation");
    await step("скрыть", "admin", "POST", "/api/admin/comments/{bad}/hide", { reason: "Спам и оскорбления" });
    await step("чат для автора", "anna", "GET", path);
    await step("чат для всех", "petr", "GET", path);
    await step("чат для админа", "admin", "GET", path);
    await step("вернуть", "admin", "POST", "/api/admin/comments/{bad}/unhide");
    await step("удалить", "anna", "DELETE", `${path}/{q}`);
    await step("ответ на удалённое", "petr", "POST", path, { text: "?", replyToId: "{q}" });
    await step("после удаления", "anna", "GET", path);
    await step("уведомления организатора", author, "GET", "/api/notifications?size=100");
    await step("уведомления автора", "anna", "GET", "/api/notifications?size=100");
  });

  scenario("организатор: разовая встреча", async () => {
    await resetBoth();
    const start = later(5, 17);
    const body = {
      title: "Флорбол во дворе", description: "Играем без контакта", sportName: "Флорбол", format: "OFFLINE", address: "Красноярск, ул. Мира, 1",
      lat: 56.01, lon: 92.85, level: "BEGINNER", capacity: 6, joinMode: "REQUEST", startAt: iso(start), endAt: iso(start + 2 * 36e5),
      privateDetails: "Чат: t.me/floorball_krsk", equipment: "Клюшка", requirements: "Кроссовки", minParticipants: 3,
    };
    await step("можно создавать", "petr", "GET", "/api/events/create-permission");
    await step("админу нельзя", "admin", "GET", "/api/events/create-permission");
    await step("в прошлом", "petr", "POST", "/api/events", { ...body, startAt: iso(Date.now() - DAY) });
    await step("без адреса", "petr", "POST", "/api/events", { ...body, address: "" });
    await step("мат", "petr", "POST", "/api/events", { ...body, title: "хуйня" });
    await step("кворум больше мест", "petr", "POST", "/api/events", { ...body, minParticipants: 9 });
    await step("создать", "petr", "POST", "/api/events", body, { save: { ev: "$.id", occ: "$.singleOccurrence.id" } });
    await step("карточка", "anna", "GET", "/api/events/{ev}");
    await step("новый вид спорта", "anna", "GET", "/api/sports?query=флорбол");
    await step("в ленте", "anna", "GET", "/api/events?searchText=флорбол");
    await step("мои", "petr", "GET", "/api/events/mine");
    await step("правка", "petr", "PUT", "/api/events/{ev}", { ...body, title: "Флорбол во дворе (обновлено)", capacity: 8 });
    await step("чужая правка", "anna", "PUT", "/api/events/{ev}", body);
    await step("объявление", "petr", "PUT", "/api/events/{ev}/announcement", { text: "Сбор в 17:45 у входа" });
    await step("объявление мат", "petr", "PUT", "/api/events/{ev}/announcement", { text: "всем хуй" });
    await step("заявка", "anna", "POST", "/api/events/{ev}/registrations", { message: "Хочу!" }, { save: { reg: "$.id" } });
    await step("объявление при заявке", "petr", "PUT", "/api/events/{ev}/announcement", { text: "Сбор в 17:30" });
    await step("снять объявление", "petr", "DELETE", "/api/events/{ev}/announcement");
    await step("фото", "petr", "POST", "/api/events/{ev}/photos?focusX=40&focusY=30", upload(png(8)), { save: { photo: "$.photos[0].id" } });
    await step("фото не картинка", "petr", "POST", "/api/events/{ev}/photos", upload(Buffer.from("hello world, not an image"), "x.png"));
    await step("фокус", "petr", "PUT", "/api/events/{ev}/photos/{photo}/focus", { x: 10, y: 20 });
    await step("карточка с фото", "anna", "GET", "/api/events/{ev}");
    await step("в ленте с обложкой", "anna", "GET", "/api/events?searchText=флорбол");
    await step("удалить фото", "petr", "DELETE", "/api/events/{ev}/photos/{photo}");
    await step("пригласить", "petr", "POST", "/api/events/{ev}/organizers", { login: "olga" });
    await step("пригласить участницу", "petr", "POST", "/api/events/{ev}/organizers", { login: "anna" });
    await step("приглашения", "olga", "GET", "/api/events/organizer-invitations");
    await step("принять", "olga", "POST", "/api/events/{ev}/organizers/invitation/accept");
    await step("карточка с соорганизатором", "petr", "GET", "/api/events/{ev}");
    await step("соорганизатор решает", "olga", "POST", "/api/registrations/{reg}/approve");
    await step("убрать", "petr", "DELETE", `/api/events/{ev}/organizers/${userId("olga")}`);
    await step("отменить встречу", "petr", "POST", "/api/events/{ev}/occurrences/{occ}/cancel", { reason: "Не хватает людей" });
    await step("карточка отменённой", "anna", "GET", "/api/events/{ev}");
    await step("запись на отменённую", "vika", "POST", "/api/events/{ev}/registrations", {});
    await step("календарь", "anna", "GET", "/api/events/{ev}/calendar.ics", undefined, {
      pick: (b) => (typeof b === "string" ? b.replace(/DTSTAMP:\S+/g, "DTSTAMP:x").replace(/UID:\S+/g, "UID:x") : b),
    });
    await step("уведомления участницы", "anna", "GET", "/api/notifications?size=100");
    await step("уведомления автора", "petr", "GET", "/api/notifications?size=100");
    await step("уведомления соорганизатора", "olga", "GET", "/api/notifications?size=100");
  });
}
