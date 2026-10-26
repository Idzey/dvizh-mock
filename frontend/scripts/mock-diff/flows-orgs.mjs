// Сценарии организаций, админки справочника, блога, бобра и профиля (см. ../mock-diff.mjs).
import { DAY, png, upload } from "./util.mjs";

const iso = (ms) => new Date(ms).toISOString();

export default function register({ scenario, step, resetBoth, db }) {
  const userId = (username) => db.users.rows.find((u) => u.username === username).id;

  scenario("организация: допуск и первая встреча", async () => {
    await resetBoth();
    await step("регистрация", null, "POST", "/api/auth/register", { username: "northclub", email: "north@club.ru", firstName: "Игорь", lastName: "Север", password: "demo-password-1", accountType: "ORG" });
    await step("занято", null, "POST", "/api/auth/register", { username: "NorthClub", email: "other@club.ru", firstName: "Игорь", lastName: "Север", password: "demo-password-1", accountType: "ORG" });
    await step("анкеты нет", "northclub", "GET", "/api/organizations/me");
    await step("нельзя публиковать", "northclub", "GET", "/api/events/create-permission");
    await step("участнику нельзя", "anna", "PUT", "/api/organizations/me", { name: "Х", description: "Х", contacts: { PHONE: "+7 900 123-45-67" }, sportNames: ["Бег"] });
    const sports = await step("виды", "anna", "GET", "/api/sports?query=бег", undefined, { save: { sport: "$[0].id" } });
    void sports;
    const form = { name: "Клуб «Север»", description: "Бегаем по северным маршрутам", city: "Красноярск", contacts: { PHONE: "+7 900 123-45-67", TELEGRAM: "@north_club" }, sportIds: ["{sport}"] };
    await step("без контактов", "northclub", "PUT", "/api/organizations/me", { ...form, contacts: {} });
    await step("плохой телефон", "northclub", "PUT", "/api/organizations/me", { ...form, contacts: { PHONE: "123" } });
    await step("плохой telegram", "northclub", "PUT", "/api/organizations/me", { ...form, contacts: { TELEGRAM: "club" } });
    await step("без вида", "northclub", "PUT", "/api/organizations/me", { ...form, sportIds: [] });
    await step("мат", "northclub", "PUT", "/api/organizations/me", { ...form, name: "Клуб хуй" });
    await step("сохранить анкету", "northclub", "PUT", "/api/organizations/me", form, { save: { org: "$.id" } });
    await step("логотип", "northclub", "PUT", "/api/organizations/me/logo", upload(png(8)));
    await step("документ", "northclub", "POST", "/api/organizations/me/documents", upload(png(8), "charter.png"));
    await step("анкета", "northclub", "GET", "/api/organizations/me");
    await step("страница не публична", "anna", "GET", "/api/organizations/{org}");
    await step("публиковать нельзя", "northclub", "GET", "/api/events/create-permission");
    await step("заявки у админа", "admin", "GET", "/api/admin/organizations?status=PENDING");
    await step("карточка заявки", "admin", "GET", "/api/admin/organizations/{org}");
    await step("уведомления админа", "admin", "GET", "/api/notifications?size=100");
    await step("на доработку", "admin", "POST", "/api/admin/organizations/{org}/return", { reason: "Добавьте описание маршрутов" });
    await step("повторно на доработку", "admin", "POST", "/api/admin/organizations/{org}/return", { reason: "Добавьте описание маршрутов" });
    await step("анкета после возврата", "northclub", "GET", "/api/organizations/me");
    await step("исправить", "northclub", "PUT", "/api/organizations/me", { ...form, description: "Бегаем по северным маршрутам, три раза в неделю" });
    await step("отклонить", "admin", "POST", "/api/admin/organizations/{org}/reject", { reason: "Нет документов" });
    await step("на доработку отклонённой", "admin", "POST", "/api/admin/organizations/{org}/return", { reason: "ещё" });
    await step("исправить после отказа", "northclub", "PUT", "/api/organizations/me", form);
    await step("одобрить", "admin", "POST", "/api/admin/organizations/{org}/approve");
    await step("одобрить ещё раз", "admin", "POST", "/api/admin/organizations/{org}/approve");
    await step("уведомления клуба", "northclub", "GET", "/api/notifications?size=100");
    await step("публичная страница", "anna", "GET", "/api/organizations/{org}");
    await step("в каталоге", "anna", "GET", "/api/organizations?searchText=север");
    await step("города", "anna", "GET", "/api/organizations/cities");
    await step("сводка", "anna", "GET", "/api/organizations/{org}/overview");
    await step("подписаться", "anna", "POST", "/api/organizations/{org}/subscription");
    await step("подписаться ещё раз", "anna", "POST", "/api/organizations/{org}/subscription");
    await step("организации нельзя", "ladya", "POST", "/api/organizations/{org}/subscription");
    await step("мои клубы", "anna", "GET", "/api/organizations?mine=true");
    await step("разрешено публиковать", "northclub", "GET", "/api/events/create-permission");
    const start = Date.now() + 4 * DAY;
    await step("встреча клуба", "northclub", "POST", "/api/events", {
      title: "Утренняя пробежка клуба", sportId: "{sport}", format: "OFFLINE", address: "Красноярск, набережная", lat: 56.0, lon: 92.9, joinMode: "FREE", capacity: 20,
      startAt: iso(start), endAt: iso(start + 36e5),
    }, { save: { ev: "$.id" } });
    await step("карточка", "anna", "GET", "/api/events/{ev}");
    await step("уведомления подписчицы", "anna", "GET", "/api/notifications?size=100");
    await step("сводка с встречей", "anna", "GET", "/api/organizations/{org}/overview");
    await step("мои встречи клуба", "northclub", "GET", "/api/events/mine");
    await step("снять логотип", "northclub", "DELETE", "/api/organizations/me/logo");
    await step("отозвать допуск", "admin", "POST", "/api/admin/organizations/{org}/reject", { reason: "Нарушения" });
    await step("лента без встреч клуба", "anna", "GET", "/api/events?searchText=пробежка клуба");
    await step("карточка встречи отозванного клуба", "anna", "GET", "/api/events/{ev}");
    await step("запись закрыта", "anna", "POST", "/api/events/{ev}/registrations", {});
    await step("правка закрыта", "northclub", "PUT", "/api/events/{ev}", {
      title: "Утренняя пробежка клуба", sportId: "{sport}", format: "OFFLINE", address: "Красноярск", lat: 56.0, lon: 92.9, startAt: iso(start), endAt: iso(start + 36e5),
    });
    await step("админ: список", "admin", "GET", "/api/admin/organizations");
  });

  scenario("админка: виды спорта", async () => {
    await resetBoth();
    const start = Date.now() + 4 * DAY;
    const body = (name) => ({ title: `Игра ${name}`, sportName: name, format: "ONLINE", onlineUrl: "https://meet.example/x", startAt: iso(start), endAt: iso(start + 36e5) });
    await step("свой вид 1", "petr", "POST", "/api/events", body("Падел-теннис"), { save: { ev1: "$.id", sp1: "$.sport.id" } });
    await step("свой вид 2", "petr", "POST", "/api/events", body("падел теннис"), { save: { sp2: "$.sport.id" } });
    await step("свой вид 3", "petr", "POST", "/api/events", body("Скейтборд"), { save: { sp3: "$.sport.id" } });
    await step("ожидают проверки", "admin", "GET", "/api/admin/sports?status=PENDING");
    await step("счётчики", "admin", "GET", "/api/admin/sports/counts");
    await step("одобрить", "admin", "POST", "/api/admin/sports/{sp1}/approve");
    await step("одобрить ещё раз", "admin", "POST", "/api/admin/sports/{sp1}/approve");
    await step("переименовать", "admin", "PUT", "/api/admin/sports/{sp1}", { name: "Падел" });
    await step("переименовать в существующий", "admin", "PUT", "/api/admin/sports/{sp3}", { name: "Бег" });
    await step("создать вид", "admin", "POST", "/api/admin/sports?name=Гребля&published=true&focusX=40&focusY=20", upload(png(256)), { save: { sp4: "$.id" } });
    await step("создать дубль", "admin", "POST", "/api/admin/sports?name=гребля", upload(png(256)));
    await step("маленькая картинка", "admin", "POST", "/api/admin/sports?name=Лапта", upload(png(64)), {});
    await step("не PNG", "admin", "POST", "/api/admin/sports?name=Городки", upload(Buffer.from("GIF89a....."), "x.gif", "image/gif"));
    await step("заменить картинку", "admin", "PUT", "/api/admin/sports/{sp4}/image?focusX=10&focusY=10", upload(png(256)));
    await step("убрать картинку", "admin", "DELETE", "/api/admin/sports/{sp4}/image");
    await step("скрыть", "admin", "POST", "/api/admin/sports/{sp3}/hide", { reason: "Не спорт" });
    await step("скрыть ещё раз", "admin", "POST", "/api/admin/sports/{sp3}/hide", { reason: "Не спорт" });
    await step("в справочнике", "anna", "GET", "/api/sports?query=скейт");
    await step("скрытый вид в форме", "petr", "POST", "/api/events", { ...body("x"), sportId: "{sp3}" });
    await step("вернуть", "admin", "POST", "/api/admin/sports/{sp3}/restore");
    await step("объединить", "admin", "POST", "/api/admin/sports/{sp2}/merge", { targetId: "{sp1}", reason: "Дубль" });
    await step("с самим собой", "admin", "POST", "/api/admin/sports/{sp1}/merge", { targetId: "{sp1}" });
    await step("мероприятие после слияния", "anna", "GET", "/api/events/{ev1}");
    await step("удалить занятый", "admin", "DELETE", "/api/admin/sports/{sp1}");
    await step("удалить свободный", "admin", "DELETE", "/api/admin/sports/{sp4}");
    await step("список", "admin", "GET", "/api/admin/sports?size=100");
    await step("поиск", "admin", "GET", "/api/admin/sports?searchText=пад");
  });

  scenario("блог", async () => {
    await resetBoth();
    const past = db.registrations.rows
      .filter((r) => r.userId === userId("anna") && r.status === "CONFIRMED")
      .map((r) => db.events.get(r.eventId))
      .find((e) => e && e.status === "PUBLISHED" && e.startAt < Date.now() - DAY);
    await step("как прошла", "anna", "GET", "/api/blog/prompt");
    await step("о каких встречах", "anna", "GET", "/api/blog/eligible-events");
    await step("админу нельзя", "admin", "POST", "/api/blog/posts", { type: "GUIDE", title: "Привет", body: "Текст", publish: true });
    await step("черновик гайда", "anna", "POST", "/api/blog/posts", { type: "GUIDE", title: "Как начать бегать", body: "# Старт\n\nНачните с **10 минут** и [плана](https://example.com).", publish: false }, { save: { post: "$.post.id" } });
    await step("мои", "anna", "GET", "/api/blog/posts/mine");
    await step("чужой черновик", "petr", "GET", "/api/blog/posts/{post}");
    await step("лайк черновика", "petr", "POST", "/api/blog/posts/{post}/like");
    await step("опубликовать", "anna", "PUT", "/api/blog/posts/{post}", { type: "GUIDE", title: "Как начать бегать", body: "# Старт\n\nНачните с **10 минут**.", publish: true, commentsEnabled: true });
    await step("в ленте", "petr", "GET", "/api/blog/posts?searchText=бегать");
    await step("лайк", "petr", "POST", "/api/blog/posts/{post}/like");
    await step("лайк ещё раз", "petr", "POST", "/api/blog/posts/{post}/like");
    await step("снять лайк", "petr", "DELETE", "/api/blog/posts/{post}/like");
    await step("лайк", "petr", "POST", "/api/blog/posts/{post}/like");
    await step("комментарий", "petr", "POST", "/api/blog/posts/{post}/comments", { text: "Полезно!" }, { save: { c1: "$.id" } });
    await step("ответ", "anna", "POST", "/api/blog/posts/{post}/comments", { text: "Рада!", replyToId: "{c1}" }, { save: { c2: "$.id" } });
    await step("правка", "petr", "PUT", "/api/blog/posts/{post}/comments/{c1}", { text: "Очень полезно!" });
    await step("чужая правка", "anna", "PUT", "/api/blog/posts/{post}/comments/{c1}", { text: "x" });
    await step("комментарии", "petr", "GET", "/api/blog/posts/{post}/comments");
    await step("закрыть комментарии", "anna", "PUT", "/api/blog/posts/{post}", { type: "GUIDE", title: "Как начать бегать", body: "Текст", publish: true, commentsEnabled: false });
    await step("комментарий в закрытые", "petr", "POST", "/api/blog/posts/{post}/comments", { text: "?" });
    await step("удалить комментарий", "petr", "DELETE", "/api/blog/posts/{post}/comments/{c1}");
    await step("пост", "petr", "GET", "/api/blog/posts/{post}");
    await step("загрузить фото", "anna", "POST", "/api/blog/photos", upload(png(8)), { save: { file: "$.id" } });
    if (past) {
      await step("пост о встрече", "anna", "POST", "/api/blog/posts", { type: "EVENT_REPORT", eventId: past.id, title: "Как прошло", body: "Было здорово", publish: true, photos: [{ fileId: "{file}", caption: "Финиш" }], widgetOrganizationId: past.organizationId ?? undefined }, { save: { rep: "$.post.id" } });
      await step("пост о чужой встрече", "petr", "POST", "/api/blog/posts", { type: "EVENT_REPORT", eventId: past.id, title: "Я тоже", body: "x", publish: true });
      await step("отчёт", "petr", "GET", "/api/blog/posts/{rep}");
      await step("фото встречи", "anna", "GET", `/api/blog/events/${past.id}/photos`);
    }
    await step("о будущей", "anna", "POST", "/api/blog/posts", { type: "EVENT_REPORT", eventId: db.events.rows.find((e) => e.startAt > Date.now() + DAY && e.status === "PUBLISHED").id, title: "x", body: "x", publish: false });
    await step("чужое удаление", "petr", "DELETE", "/api/blog/posts/{post}");
    await step("удаление админом", "admin", "DELETE", "/api/blog/posts/{post}");
    await step("после удаления", "anna", "GET", "/api/blog/posts/{post}");
    await step("авторы", "anna", "GET", "/api/blog/authors");
  });

  scenario("бобр и магазин", async () => {
    await resetBoth();
    await step("бобр", "anna", "GET", "/api/users/me/pet");
    await step("чужой бобр", "petr", "GET", "/api/users/anna/pet");
    await step("надеть чужое", "anna", "PUT", "/api/users/me/pet/slots/hat", { item: "crown" });
    await step("надеть базовое", "anna", "PUT", "/api/users/me/pet/slots/hat", { item: "headband" });
    await step("нет такой вещи", "anna", "PUT", "/api/users/me/pet/slots/hat", { item: "zzz" });
    await step("нет слота", "anna", "PUT", "/api/users/me/pet/slots/zzz", { item: "cap" });
    await step("снять", "anna", "PUT", "/api/users/me/pet/slots/hat", { item: null });
    await step("магазин", "anna", "GET", "/api/pets/shop");
    await step("купить эксклюзив", "anna", "POST", "/api/pets/shop/neck:medal/buy");
    await step("купить кепку", "anna", "POST", "/api/pets/shop/hat:cap/buy");
    await step("купить ещё раз", "anna", "POST", "/api/pets/shop/hat:cap/buy");
    await step("нет такой", "anna", "POST", "/api/pets/shop/hat:zzz/buy");
    await step("надеть кепку", "anna", "PUT", "/api/users/me/pet/slots/hat", { item: "cap" });
    await step("кошелёк", "anna", "GET", "/api/users/me/wallet");
    await step("слишком дорого", "anna", "POST", "/api/pets/shop/shirt:zenit/buy");
    await step("комплекты", "anna", "GET", "/api/pets/shop/bundles");
    await step("комплект бег", "anna", "POST", "/api/pets/shop/bundles/running/buy");
    await step("комплект нет", "anna", "POST", "/api/pets/shop/bundles/zzz/buy");
    await step("набор", "anna", "POST", "/api/pets/shop/buy-set", { items: ["hat:beanie", "eyewear:sunglasses"], wear: true });
    await step("переименовать", "anna", "PUT", "/api/users/me/pet/name", { name: "  Шарик   Второй  " });
    await step("слишком длинное имя", "anna", "PUT", "/api/users/me/pet/name", { name: "очень длинное имя бобра больше тридцати символов" });
    await step("образ", "anna", "PUT", "/api/users/me/pet", { activity: "none", outfit: { hat: "cap", shirt: "training" } });
    await step("чужой образ", "anna", "PUT", "/api/users/me/pet", { activity: "none", outfit: { hat: "crown" } });
    await step("сохранить образ", "anna", "POST", "/api/users/me/pet/looks", { name: "Бегун", activity: "none", outfit: { hat: "cap", shirt: "training" } }, { save: { look: "$.id" } });
    await step("образы", "anna", "GET", "/api/users/me/pet/looks");
    await step("удалить образ", "anna", "DELETE", "/api/users/me/pet/looks/{look}");
    await step("развеселить", "anna", "POST", "/api/users/me/pet/cheer");
    await step("бобр после", "anna", "GET", "/api/users/me/pet");
    await step("кошелёк после", "anna", "GET", "/api/users/me/wallet");
    await step("организации нельзя", "ladya", "GET", "/api/pets/shop");
    await step("вещи админа", "admin", "GET", "/api/admin/pets/items");
    await step("загрузка вещи", "admin", "POST", "/api/admin/pets/items/preview?bodyPart=HAT", upload(png(8)));
  });

  scenario("профиль", async () => {
    await resetBoth();
    await step("валидация", "anna", "PUT", "/api/users/me", { firstName: "А", lastName: "" });
    await step("мат", "anna", "PUT", "/api/users/me", { firstName: "Анна", lastName: "Смирнова", bio: "я хуй" });
    await step("профиль", "anna", "PUT", "/api/users/me", { firstName: "Анна", lastName: "Смирнова", city: "Красноярск", bio: "Люблю бег и йогу. Пиши в лс, заработай деньги на t.me/spamchannel" });
    await step("очередь модерации", "admin", "GET", "/api/admin/moderation");
    await step("публичный профиль", "petr", "GET", "/api/users/anna");
    await step("аватар", "anna", "PUT", "/api/users/me/avatar", upload(png(8)));
    await step("аватар не картинка", "anna", "PUT", "/api/users/me/avatar", upload(Buffer.from("not an image at all"), "a.png"));
    await step("убрать аватар", "anna", "DELETE", "/api/users/me/avatar");
    await step("фото", "anna", "POST", "/api/users/me/photos", upload(png(8)), { save: { photo: "$[0].id" } });
    await step("фото ещё", "anna", "POST", "/api/users/me/photos", upload(png(8)));
    await step("мои фото", "anna", "GET", "/api/users/me/photos");
    await step("удалить фото", "anna", "DELETE", "/api/users/me/photos/{photo}");
    await step("очистить текст", "admin", "GET", "/api/admin/moderation?targetType=USER_PROFILE");
    await step("виды спорта", "anna", "PUT", "/api/users/me/sports", { sports: [{ sportName: "Скалолазание", level: "AMATEUR" }, { sportName: "Йога", level: "BEGINNER" }] });
    await step("мои виды", "anna", "GET", "/api/users/me/sports");
    await step("предпочтения", "anna", "PUT", "/api/users/me/preferences", { level: "AMATEUR", days: ["SATURDAY", "MONDAY"], daytime: "MORNING", radiusKm: 7, helpers: { reminders: true, nearby: false, cheer: true }, home: { lat: 56.01, lon: 92.85 } });
    await step("предпочтения чтение", "anna", "GET", "/api/users/me/preferences");
    await step("подборка после", "anna", "GET", "/api/recommendations/events?size=10");
    await step("не интересно", "anna", "POST", `/api/recommendations/events/${db.events.rows.find((e) => e.status === "PUBLISHED" && e.startAt > Date.now() + DAY && !e.recurring).id}/dismiss`, { reason: "NOT_MY_SPORT" });
    await step("подборка после скрытия", "anna", "GET", "/api/recommendations/events?size=10");
    await step("настройки уведомлений", "anna", "PUT", "/api/notifications/settings", { channels: ["EMAIL"], categories: ["EVENTS", "REGISTRATIONS"] });
    await step("почта", "anna", "PUT", "/api/notifications/email", { email: "anna@example.com" });
    await step("телефон", "anna", "PUT", "/api/notifications/max", { phone: "8 (900) 123-45-67" });
    await step("настройки", "anna", "GET", "/api/notifications/settings");
    await step("прочитать всё", "anna", "POST", "/api/notifications/read-all", { throughRevision: 9999 });
    const unread = db.notifications.rows.find((n) => n.userId === userId("anna") && !n.readAt);
    await step("прочитать одно", "anna", "POST", `/api/notifications/${unread.id}/read`);
    await step("счётчики", "anna", "GET", "/api/notifications/unread-counts");
    await step("опрос", "anna", "GET", "/api/notifications/poll?revision=0&timeoutSeconds=0");
  });
}
