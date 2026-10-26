// Сценарии с записью: одинаковые действия на настоящем бэкенде и на моке, ответы и последствия сравниваются.
// Перед каждым сценарием оба мира сбрасываются в состояние снапшота.

const DAY = 864e5;

export default function register({ scenario, step, resetBoth, db }) {
  const now = () => Date.now();
  const confirmedCount = (id) => db.registrations.rows.filter((r) => r.eventId === id && r.status === "CONFIRMED").length;
  const registration = (eventId, userId) => db.registrations.rows.find((r) => r.eventId === eventId && r.userId === userId);
  const userId = (username) => db.users.rows.find((u) => u.username === username).id;
  const organizerIds = (e) => new Set([e.authorId, ...db.eventOrganizers.rows.filter((o) => o.eventId === e.id).map((o) => o.userId)]);
  const MAIN = new Set(["admin", "anna", "petr", "olga", "dmitry", "elena", "sergey", "nikolai", "vika", "ladya", "enisey", "yoga", "bobry"]);
  const isMain = (e) => MAIN.has(db.users.get(e.authorId).username);
  /** Будущее опубликованное разовое мероприятие по условию. */
  const upcoming = (predicate) =>
    db.events.rows
      .filter((e) => e.status === "PUBLISHED" && !e.recurring && e.startAt > now() + DAY && (!e.organizationId || db.organizations.get(e.organizationId)?.status === "APPROVED"))
      .filter((e) => !db.eventOccurrences.rows.some((o) => o.eventId === e.id && o.status === "CANCELLED"))
      .filter(predicate)
      .sort((a, b) => a.startAt - b.startAt);

  scenario("запись: свободная", async () => {
    await resetBoth();
    const me = userId("anna");
    const event = upcoming((e) => e.joinMode === "FREE" && (e.capacity == null || confirmedCount(e.id) < e.capacity - 1) && !organizerIds(e).has(me) && !registration(e.id, me))[0];
    const path = `/api/events/${event.id}`;
    await step("до", "anna", "GET", path);
    await step("записаться", "anna", "POST", `${path}/registrations`, { message: "Приду!" });
    await step("повторно", "anna", "POST", `${path}/registrations`, {});
    await step("после", "anna", "GET", path);
    await step("мои записи", "anna", "GET", "/api/registrations/mine");
    await step("отменить", "anna", "DELETE", `${path}/registrations/me`);
    await step("отменить ещё раз", "anna", "DELETE", `${path}/registrations/me`);
    await step("записаться снова", "anna", "POST", `${path}/registrations`, {});
    await step("организатор видит", "ladya", "GET", `${path}/registrations`);
    await step("уведомления организатора", "petr", "GET", "/api/notifications?size=100");
    await step("организатор записывается", "admin", "POST", `${path}/registrations`, {});
    await step("несуществующее", "anna", "POST", "/api/events/00000000-0000-0000-0000-000000000000/registrations", {});
  });

  scenario("запись: по заявке", async () => {
    await resetBoth();
    const me = userId("anna");
    const event = upcoming((e) => isMain(e) && e.joinMode === "REQUEST" && (e.capacity == null || confirmedCount(e.id) < e.capacity - 1) && !organizerIds(e).has(me) && !registration(e.id, me))[0];
    const author = db.users.get(event.authorId).username;
    const path = `/api/events/${event.id}`;
    await step("подать заявку", "anna", "POST", `${path}/registrations`, { message: "Можно мне?" }, { save: { reg: "$.id" } });
    await step("карточка", "anna", "GET", path);
    await step("заявки организатору", author, "GET", `${path}/registrations?status=PENDING`);
    await step("принять", author, "POST", "/api/registrations/{reg}/approve");
    await step("принять ещё раз", author, "POST", "/api/registrations/{reg}/approve");
    await step("карточка после", "anna", "GET", path);
    await step("исключить", author, "POST", "/api/registrations/{reg}/reject", { reason: "Не подошли по уровню" });
    await step("карточка исключённого", "anna", "GET", path);
    await step("отмена исключённого", "anna", "DELETE", `${path}/registrations/me`);
    await step("повторная подача", "anna", "POST", `${path}/registrations`, {});
    await step("вернуть", author, "POST", "/api/registrations/{reg}/approve");
    await step("бобр", "anna", "GET", "/api/users/me/pet");
    await step("уведомления участницы", "anna", "GET", "/api/notifications?size=100");
    await step("уведомления организатора", author, "GET", "/api/notifications?size=100");
    await step("чужая заявка", "petr", "POST", "/api/registrations/{reg}/reject", { reason: "x" });
  });

  scenario("запись: лист ожидания", async () => {
    await resetBoth();
    const full = upcoming((e) => e.joinMode === "FREE" && e.capacity != null && confirmedCount(e.id) >= e.capacity)[0];
    const me = userId("anna");
    const path = `/api/events/${full.id}`;
    const confirmed = db.registrations.rows.find((r) => r.eventId === full.id && r.status === "CONFIRMED");
    const confirmedUser = db.users.get(confirmed.userId).username;
    await step("мест нет", "anna", "GET", path);
    await step("встать в очередь", "anna", "POST", `${path}/registrations`, {});
    await step("позиция", "anna", "GET", path);
    await step("освободить место", confirmedUser, "DELETE", `${path}/registrations/me`);
    await step("после продвижения", "anna", "GET", path);
    await step("мои записи", "anna", "GET", "/api/registrations/mine");
    await step("уведомления", "anna", "GET", "/api/notifications?size=100");
    void me;
  });

  scenario("серия: отметки на занятия", async () => {
    await resetBoth();
    const series = db.events.rows.find((e) => e.recurring && e.status === "PUBLISHED" && e.joinMode === "FREE");
    const me = userId("anna");
    const path = `/api/events/${series.id}`;
    const occ = db.eventOccurrences.rows.filter((o) => o.eventId === series.id && o.status === "SCHEDULED" && o.startAt > now() + DAY).sort((a, b) => a.startAt - b.startAt);
    await step("занятия", "anna", "GET", `${path}/occurrences`);
    await step("вступить в серию", "anna", "POST", `${path}/registrations`, {});
    await step("приду", "anna", "POST", `${path}/occurrences/${occ[0].id}/attendance`);
    await step("приду ещё раз", "anna", "POST", `${path}/occurrences/${occ[0].id}/attendance`);
    await step("приду на второе", "anna", "POST", `${path}/occurrences/${occ[1].id}/attendance`);
    await step("занятия после", "anna", "GET", `${path}/occurrences`);
    await step("не приду", "anna", "DELETE", `${path}/occurrences/${occ[0].id}/attendance`);
    await step("выйти из серии", "anna", "DELETE", `${path}/registrations/me`);
    await step("занятия после выхода", "anna", "GET", `${path}/occurrences`);
    void me;
  });
}
