// Сценарии серий: расписание по RRULE, занятия, кворум (см. ../mock-diff.mjs).
import { DAY } from "./util.mjs";

const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, "0");
/** «YYYY-MM-DD» в Красноярске (UTC+7) через n дней. */
const localDate = (days) => {
  const d = new Date(Date.now() + days * DAY + 7 * 36e5);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export default function register({ scenario, step, resetBoth, db }) {
  const userId = (username) => db.users.rows.find((u) => u.username === username).id;

  const series = (extra = {}) => ({
    title: "Йога на рассвете", description: "Спокойная практика", sportName: "Йога", format: "OFFLINE", address: "Красноярск, Центральный парк", lat: 56.0107, lon: 92.8528,
    level: "ANY", capacity: 5, joinMode: "FREE", minParticipants: 2,
    schedule: {
      timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(40),
      rules: [
        { firstStart: `${localDate(2)}T07:30:00`, durationMinutes: 60, rrule: "FREQ=WEEKLY;BYDAY=TU,TH" },
        { firstStart: `${localDate(3)}T19:00:00`, durationMinutes: 90, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SA" },
      ],
    },
    ...extra,
  });

  scenario("серия: расписание", async () => {
    await resetBoth();
    await step("без правил", "petr", "POST", "/api/events", series({ schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(20), rules: [] } }));
    await step("частота час", "petr", "POST", "/api/events", series({ schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(20), rules: [{ firstStart: `${localDate(2)}T07:30:00`, durationMinutes: 60, rrule: "FREQ=HOURLY" }] } }));
    await step("больше года", "petr", "POST", "/api/events", series({ schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(500), rules: [{ firstStart: `${localDate(2)}T07:30:00`, durationMinutes: 60, rrule: "FREQ=DAILY" }] } }));
    await step("пояс смещением", "petr", "POST", "/api/events", series({ schedule: { timeZone: "+07:00", startDate: localDate(1), endDate: localDate(20), rules: [{ firstStart: `${localDate(2)}T07:30:00`, durationMinutes: 60, rrule: "FREQ=DAILY" }] } }));
    await step("с датами одноразового", "petr", "POST", "/api/events", series({ startAt: iso(Date.now() + 5 * DAY) }));
    await step("создать", "petr", "POST", "/api/events", series(), { save: { ev: "$.id" } });
    await step("карточка", "anna", "GET", "/api/events/{ev}");
    await step("занятия", "anna", "GET", "/api/events/{ev}/occurrences");
    await step("лента", "anna", "GET", "/api/events?searchText=йога на рассвете");
    await step("на карте", "anna", "GET", "/api/events/map?minLon=92&minLat=55.5&maxLon=93.5&maxLat=56.5&from=" + encodeURIComponent(iso(Date.now())) + "&to=" + encodeURIComponent(iso(Date.now() + 40 * DAY)));
    await step("ежедневное", "petr", "POST", "/api/events", series({ title: "Зарядка ежедневно", schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(15), rules: [{ firstStart: `${localDate(2)}T06:00:00`, durationMinutes: 20, rrule: "FREQ=DAILY;INTERVAL=2;COUNT=4" }] } }), { save: { ev2: "$.id" } });
    await step("занятия ежедневного", "anna", "GET", "/api/events/{ev2}/occurrences");
    await step("ежемесячное", "petr", "POST", "/api/events", series({ title: "Клубный сбор", schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(200), rules: [{ firstStart: `${localDate(2)}T12:00:00`, durationMinutes: 60, rrule: "FREQ=MONTHLY;BYDAY=1SA" }] } }), { save: { ev3: "$.id" } });
    await step("занятия ежемесячного", "anna", "GET", "/api/events/{ev3}/occurrences");
    await step("карточка ежемесячного", "anna", "GET", "/api/events/{ev3}");
  });

  scenario("серия: занятия и кворум", async () => {
    await resetBoth();
    await step("создать", "petr", "POST", "/api/events", series(), { save: { ev: "$.id" } });
    await step("вступить", "anna", "POST", "/api/events/{ev}/registrations", {});
    await step("вступить 2", "vika", "POST", "/api/events/{ev}/registrations", {});
    const list = await step("занятия", "petr", "GET", "/api/events/{ev}/occurrences", undefined, { save: { o1: "$[0].id", o2: "$[1].id", o3: "$[2].id" } });
    void list;
    await step("приду", "anna", "POST", "/api/events/{ev}/occurrences/{o1}/attendance");
    await step("кворум", "petr", "GET", "/api/events/{ev}/occurrences");
    await step("приду 2", "vika", "POST", "/api/events/{ev}/occurrences/{o1}/attendance");
    await step("кворум набран", "petr", "GET", "/api/events/{ev}/occurrences");
    await step("карточка", "anna", "GET", "/api/events/{ev}");
    await step("подтвердить", "petr", "POST", "/api/events/{ev}/occurrences/{o1}/confirm");
    await step("чужое подтверждение", "anna", "POST", "/api/events/{ev}/occurrences/{o1}/confirm");
    await step("кто придёт", "petr", "GET", "/api/events/{ev}/occurrences/{o1}/attendees");
    await step("кто придёт (чужой)", "anna", "GET", "/api/events/{ev}/occurrences/{o1}/attendees");
    await step("перенос", "petr", "PUT", "/api/events/{ev}/occurrences/{o2}", { startAt: iso(Date.now() + 3 * DAY + 5 * 36e5) });
    await step("перенос в прошлое", "petr", "PUT", "/api/events/{ev}/occurrences/{o2}", { startAt: iso(Date.now() - DAY) });
    await step("отмена занятия", "petr", "POST", "/api/events/{ev}/occurrences/{o3}/cancel", { reason: "Праздник" });
    await step("отметка на отменённое", "anna", "POST", "/api/events/{ev}/occurrences/{o3}/attendance");
    await step("добавить дату", "petr", "POST", "/api/events/{ev}/occurrences", { startAt: iso(Date.now() + 9 * DAY), endAt: iso(Date.now() + 9 * DAY + 36e5) });
    await step("дата вне серии", "petr", "POST", "/api/events/{ev}/occurrences", { startAt: iso(Date.now() + 200 * DAY), endAt: iso(Date.now() + 200 * DAY + 36e5) });
    await step("занятия после", "anna", "GET", "/api/events/{ev}/occurrences");
    await step("правка расписания", "petr", "PUT", "/api/events/{ev}", series({ schedule: { timeZone: "Asia/Krasnoyarsk", startDate: localDate(1), endDate: localDate(40), rules: [{ firstStart: `${localDate(2)}T07:30:00`, durationMinutes: 45, rrule: "FREQ=WEEKLY;BYDAY=TU" }] } }));
    await step("занятия после правки", "anna", "GET", "/api/events/{ev}/occurrences");
    await step("лимит меньше отметок", "petr", "PUT", "/api/events/{ev}", series({ capacity: 1 }));
    await step("карточка после", "anna", "GET", "/api/events/{ev}");
    await step("календарь участницы", "anna", "GET", "/api/events/{ev}/calendar.ics", undefined, { pick: (b) => (typeof b === "string" ? b.replace(/DTSTAMP:\S+/g, "DTSTAMP:x").replace(/UID:\S+/g, "UID:x") : b) });
    await step("выйти из серии", "anna", "DELETE", "/api/events/{ev}/registrations/me");
    await step("мои записи", "vika", "GET", "/api/registrations/mine");
    await step("снять админом", "admin", "POST", "/api/admin/events/{ev}/unpublish", { reason: "Нарушение правил" });
    await step("карточка снятой", "vika", "GET", "/api/events/{ev}");
    await step("вернуть", "admin", "POST", "/api/admin/events/{ev}/restore");
    await step("удалить", "admin", "DELETE", "/api/admin/events/{ev}", { reason: "Дубль" });
    await step("чат закрыт", "vika", "POST", "/api/events/{ev}/comments", { text: "Привет" });
    await step("уведомления", "vika", "GET", "/api/notifications?size=100");
    await step("уведомления автора", "petr", "GET", "/api/notifications?size=100");
    void userId;
  });
}
