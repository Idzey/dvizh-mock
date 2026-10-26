// Сценарии сверки мока с бэкендом (см. ../mock-diff.mjs). Сначала чтение, потом сценарии с записью.
const USERS = ["anna", "petr", "vika", "olga", "ladya", "enisey", "admin"];
const PERSONAL = ["anna", "petr", "vika", "olga"];

export default function register({ scenario, check, real }) {
  scenario("auth и профиль", async () => {
    for (const u of USERS) {
      await check("", u, "GET", "/api/auth/me");
      await check("", u, "GET", `/api/users/${u}`);
    }
    await check("без входа", null, "GET", "/api/auth/me");
    await check("логин занят?", null, "GET", "/api/auth/users/check/username?username=anna");
    await check("логин свободен?", null, "GET", "/api/auth/users/check/username?username=zzzfree");
    await check("email занят?", null, "GET", "/api/auth/users/check/email?email=anna@demo.local");
    await check("демо-аккаунты", null, "GET", "/api/demo/accounts");
    await check("плохой пароль", null, "POST", "/api/auth/login", { username: "anna", password: "bad" });
    await check("пустая форма", null, "POST", "/api/auth/login", { username: "", password: "" });
    await check("валидация регистрации", null, "POST", "/api/auth/register", { username: "ab", email: "x", firstName: "A", lastName: "", password: "1" });
    await check("логин занят", null, "POST", "/api/auth/register", { username: "anna", email: "new@x.ru", firstName: "Аня", lastName: "Тест", password: "12345678" });
  });

  scenario("виды спорта", async () => {
    await check("все", "anna", "GET", "/api/sports");
    await check("поиск", "anna", "GET", "/api/sports?query=бег");
    await check("опечатка", "anna", "GET", "/api/sports?query=падэл");
    await check("ё", "anna", "GET", "/api/sports?query=зарядка");
  });

  scenario("лента", async () => {
    for (const u of PERSONAL) {
      await check("", u, "GET", "/api/events?size=100");
      await check("стр 2", u, "GET", "/api/events?size=20&page=1");
    }
    await check("поиск", "anna", "GET", "/api/events?searchText=бег");
    await check("уровень", "anna", "GET", "/api/events?level=BEGINNER");
    await check("запись по заявке", "anna", "GET", "/api/events?joinMode=REQUEST");
    await check("онлайн", "anna", "GET", "/api/events?format=ONLINE");
    await check("для меня", "anna", "GET", "/api/events?forMe=true");
    await check("рядом", "anna", "GET", "/api/events?lat=56.0106&lon=92.8526&radiusKm=10");
    await check("неделя", "petr", "GET", `/api/events?to=${encodeURIComponent(new Date(Date.now() + 7 * 864e5).toISOString())}`);
  });

  scenario("карточки мероприятий", async () => {
    const list = await real("anna", "GET", "/api/events?size=100");
    const ids = list.body.items.map((e) => e.id);
    const sample = ids.filter((_, i) => i % 3 === 0).slice(0, 30);
    for (const id of sample) await check("", "anna", "GET", `/api/events/${id}`);
    for (const id of sample.slice(0, 8)) {
      await check("петр", "petr", "GET", `/api/events/${id}`);
      await check("ладья", "ladya", "GET", `/api/events/${id}`);
      await check("admin", "admin", "GET", `/api/events/${id}`);
    }
  });

  scenario("мои мероприятия и записи", async () => {
    for (const u of [...PERSONAL, "ladya", "enisey"]) {
      await check("", u, "GET", "/api/events/mine");
      await check("прошедшие", u, "GET", "/api/events/mine?when=PAST");
      await check("", u, "GET", "/api/registrations/mine");
      await check("прошедшие", u, "GET", "/api/registrations/mine?when=PAST");
      await check("", u, "GET", "/api/events/create-permission");
      await check("", u, "GET", "/api/events/organizer-invitations");
    }
  });

  scenario("занятия и обсуждения", async () => {
    const mine = await real("petr", "GET", "/api/events/mine");
    for (const e of mine.body.items.slice(0, 12)) {
      await check("занятия", "petr", "GET", `/api/events/${e.id}/occurrences`);
      await check("чат", "petr", "GET", `/api/events/${e.id}/comments`);
      await check("чат админ", "admin", "GET", `/api/events/${e.id}/comments`);
      await check("заявки", "petr", "GET", `/api/events/${e.id}/registrations`);
    }
  });

  scenario("уведомления", async () => {
    for (const u of [...PERSONAL, "ladya", "enisey", "admin"]) {
      await check("", u, "GET", "/api/notifications?size=100");
      await check("", u, "GET", "/api/notifications/unread-counts", undefined, { pick: (b) => (Array.isArray(b) ? [...b].sort((x, y) => x.type.localeCompare(y.type)) : b) });
      await check("", u, "GET", "/api/notifications/settings");
      await check("", u, "GET", "/api/notifications/telegram");
    }
  });

  scenario("организации", async () => {
    await check("каталог", "anna", "GET", "/api/organizations");
    await check("каталог 2", "anna", "GET", "/api/organizations?page=1&size=5");
    await check("мои", "anna", "GET", "/api/organizations?mine=true");
    await check("поиск", "petr", "GET", "/api/organizations?searchText=клуб");
    await check("города", "anna", "GET", "/api/organizations/cities");
    await check("организация месяца", "anna", "GET", "/api/organizations/featured");
    const list = await real("anna", "GET", "/api/organizations?size=100");
    for (const o of list.body.items.slice(0, 12)) {
      await check("страница", "anna", "GET", `/api/organizations/${o.id}`);
      await check("сводка", "anna", "GET", `/api/organizations/${o.id}/overview`);
      await check("архив", "anna", "GET", `/api/organizations/${o.id}/meetings`);
      await check("фото", "anna", "GET", `/api/organizations/${o.id}/photos`);
    }
    for (const u of ["ladya", "enisey", "bobry", "yoga"]) await check("анкета", u, "GET", "/api/organizations/me");
    await check("не организация", "anna", "GET", "/api/organizations/me");
  });

  scenario("блог", async () => {
    await check("лента", "anna", "GET", "/api/blog/posts?size=50");
    await check("гайды", "anna", "GET", "/api/blog/posts?type=GUIDE");
    await check("поиск", "anna", "GET", "/api/blog/posts?searchText=бег");
    for (const u of ["anna", "petr", "vika", "ladya", "admin"]) {
      await check("мои", u, "GET", "/api/blog/posts/mine");
      await check("как прошла", u, "GET", "/api/blog/prompt");
      await check("о каких встречах", u, "GET", "/api/blog/eligible-events");
    }
    await check("авторы", "anna", "GET", "/api/blog/authors");
    const list = await real("anna", "GET", "/api/blog/posts?size=50");
    for (const p of list.body.items) {
      await check("пост", "anna", "GET", `/api/blog/posts/${p.post?.id ?? p.id}`);
      await check("комментарии", "anna", "GET", `/api/blog/posts/${p.id}/comments`);
    }
  });

  scenario("рекомендации", async () => {
    for (const u of PERSONAL) {
      await check("подборка", u, "GET", "/api/recommendations/events?size=20");
      await check("стр 2", u, "GET", "/api/recommendations/events?size=10&page=1");
      await check("клубы", u, "GET", "/api/recommendations/organizations");
    }
    await check("рядом", "anna", "GET", "/api/recommendations/events?lat=56.0106&lon=92.8526&radiusKm=7");
    await check("не участник", "ladya", "GET", "/api/recommendations/events");
    const feed = await real("anna", "GET", "/api/recommendations/events?size=6");
    for (const r of feed.body.items.slice(0, 6)) {
      await check("разбор", "anna", "GET", `/api/recommendations/events/${r.event.id}/explain`);
      await check("похожие", "anna", "GET", `/api/events/${r.event.id}/similar`);
    }
  });

  scenario("альбом и фото", async () => {
    for (const u of ["anna", "petr", "vika", "olga"]) {
      await check("профиль-фото", u, "GET", "/api/users/me/photos");
      await check("папки", u, "GET", `/api/users/${u}/album/events`);
      await check("альбом", u, "GET", `/api/users/${u}/album`);
      await check("можно добавить", u, "GET", "/api/users/me/album/eligible-events");
      await check("достижения", u, "GET", `/api/users/${u}/achievements`);
    }
  });

  scenario("админка", async () => {
    await check("статистика", "admin", "GET", "/api/admin/stats?days=30", undefined, { ignore: [/signupsByDay/] });
    await check("статистика год", "admin", "GET", "/api/admin/stats?days=365", undefined, { ignore: [/signupsByDay/] });
    await check("мероприятия", "admin", "GET", "/api/admin/events?size=50");
    await check("снятые", "admin", "GET", "/api/admin/events?status=UNPUBLISHED");
    await check("удалённые", "admin", "GET", "/api/admin/events?status=DELETED");
    await check("поиск", "admin", "GET", "/api/admin/events?searchText=бег");
    await check("пользователи", "admin", "GET", "/api/admin/users?size=50");
    await check("организации-пользователи", "admin", "GET", "/api/admin/users?role=ORG");
    await check("поиск", "admin", "GET", "/api/admin/users?searchText=anna");
    await check("организации", "admin", "GET", "/api/admin/organizations");
    await check("на проверке", "admin", "GET", "/api/admin/organizations?status=PENDING");
    await check("отклонены", "admin", "GET", "/api/admin/organizations?status=REJECTED");
    const orgs = await real("admin", "GET", "/api/admin/organizations?size=100");
    for (const o of orgs.body.items.slice(0, 10)) await check("карточка", "admin", "GET", `/api/admin/organizations/${o.id}`);
    await check("очередь", "admin", "GET", "/api/admin/moderation");
    await check("все проверки", "admin", "GET", "/api/admin/moderation?status=CLEAN&size=30");
    await check("сообщения", "admin", "GET", "/api/admin/moderation?targetType=COMMENT&status=CLEAN&size=30");
    await check("виды", "admin", "GET", "/api/admin/sports?size=50");
    await check("свои виды", "admin", "GET", "/api/admin/sports?status=PENDING");
    await check("без картинок", "admin", "GET", "/api/admin/sports?withoutImage=true");
    await check("счётчики", "admin", "GET", "/api/admin/sports/counts");
    await check("награды", "admin", "GET", "/api/admin/awards");
    await check("награды за месяц", "admin", "GET", "/api/admin/awards?month=2026-09");
    await check("вещи бобра", "admin", "GET", "/api/admin/pets/items");
    await check("не админ", "anna", "GET", "/api/admin/stats");
  });

  scenario("бобр и экономика", async () => {
    for (const u of PERSONAL) {
      await check("", u, "GET", "/api/users/me/pet");
      await check("", u, "GET", "/api/pets/shop");
      await check("", u, "GET", "/api/pets/shop/bundles");
      await check("", u, "GET", "/api/users/me/wallet");
      await check("", u, "GET", "/api/users/me/achievements");
      await check("", u, "GET", "/api/users/me/pet/looks");
      await check("", u, "GET", "/api/users/me/preferences");
      await check("", u, "GET", "/api/users/me/sports");
      await check("", u, "GET", "/api/users/me/leave-tip");
      await check("", u, "GET", "/api/users/me/history");
      await check("", u, "GET", "/api/users/me/history/summary");
    }
    await check("каталог", "anna", "GET", "/api/pets/catalog");
    await check("чужой бобр", "anna", "GET", "/api/users/petr/pet");
    await check("не личный", "ladya", "GET", "/api/users/me/wallet");
  });
}
