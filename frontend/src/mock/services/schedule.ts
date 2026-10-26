// Расписание серии: проверка и разворот RRULE в занятия (порт ScheduleExpander) и описание словами (ScheduleDescriptions).
// Поддержаны DAILY, WEEKLY и MONTHLY с INTERVAL, BYDAY, BYMONTHDAY, COUNT и UNTIL — этого хватает форме и демо-данным.
import { badRequest } from "../http";
import { DAY, pad2, parseDate, zonedToMs } from "../util/time";

export const MAX_OCCURRENCES = 500;
export const MAX_SERIES_DAYS = 366;
const MAX_STEPS = 10_000;

type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/** 1 (пн) … 7 (вс) */
const dowNumber = (day: Weekday) => WEEKDAYS.indexOf(day) + 1;

export type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay: { pos: number; day: Weekday }[];
  byMonthDay: number[];
  count: number | null;
  until: number | null;
  parts: Set<string>;
};

const message = (label: string, text: string) => (label ? label + text : text.charAt(0).toUpperCase() + text.slice(1));

const SUPPORTED = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"]);

/** Строгий разбор; ошибки — 400 с текстом для человека. */
export function parseRule(rrule: string, label = ""): Rule {
  let text = rrule.trim();
  if (text.toUpperCase().startsWith("RRULE:")) text = text.slice("RRULE:".length);
  const raw = new Map<string, string>();
  for (const part of text.split(";")) {
    if (!part) continue;
    const [k, v] = part.split("=");
    if (!k || v === undefined || v === "") throw badRequest(message(label, `не удалось разобрать правило повторения (${part})`));
    raw.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = raw.get("FREQ");
  if (!freq) throw badRequest(message(label, "не удалось разобрать правило повторения (нет FREQ)"));
  if (["SECONDLY", "MINUTELY", "HOURLY"].includes(freq)) throw badRequest(message(label, "занятия не могут повторяться чаще раза в день"));
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
    throw badRequest(message(label, `не удалось разобрать правило повторения (FREQ=${freq} не поддерживается)`));
  }
  const interval = raw.has("INTERVAL") ? Number(raw.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) throw badRequest(message(label, "не удалось разобрать правило повторения (INTERVAL)"));
  const byDay = (raw.get("BYDAY")?.split(",") ?? []).map((token) => {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
    if (!m) throw badRequest(message(label, `не удалось разобрать правило повторения (BYDAY=${token})`));
    return { pos: m[1] ? Number(m[1]) : 0, day: m[2] as Weekday };
  });
  const byMonthDay = (raw.get("BYMONTHDAY")?.split(",") ?? []).map(Number);
  if (byMonthDay.some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > 31)) {
    throw badRequest(message(label, "не удалось разобрать правило повторения (BYMONTHDAY)"));
  }
  let until: number | null = null;
  if (raw.has("UNTIL")) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw.get("UNTIL") as string);
    if (!m) throw badRequest(message(label, "не удалось разобрать правило повторения (UNTIL)"));
    until = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59);
  }
  const count = raw.has("COUNT") ? Number(raw.get("COUNT")) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) throw badRequest(message(label, "не удалось разобрать правило повторения (COUNT)"));
  return { freq: freq as Rule["freq"], interval, byDay, byMonthDay, count, until, parts: new Set(raw.keys()) };
}

/** Каноничный вид правила (без префикса RRULE:, части в верхнем регистре). */
export function canonical(rrule: string): string {
  let text = rrule.trim();
  if (text.toUpperCase().startsWith("RRULE:")) text = text.slice("RRULE:".length);
  return text.toUpperCase();
}

export function zoneOf(timeZone: string): string {
  const name = (timeZone ?? "").trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
  } catch {
    throw badRequest(`Неизвестный часовой пояс: ${timeZone}`);
  }
  if (!name.includes("/") && name !== "UTC") throw badRequest("Укажите часовой пояс по названию, например Asia/Krasnoyarsk");
  return name;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function matchesDay(rule: Rule, startDay: number, startDow: number, startY: number, startM: number, startD: number, day: number, y: number, m: number, d: number, dow: number): boolean {
  const offset = day - startDay;
  switch (rule.freq) {
    case "DAILY":
      return offset % rule.interval === 0;
    case "WEEKLY": {
      // недели считаем от понедельника недели первого занятия
      const weekIndex = Math.floor((offset + (startDow - 1)) / 7);
      if (weekIndex % rule.interval !== 0) return false;
      const days = rule.byDay.length ? rule.byDay.map((b) => dowNumber(b.day)) : [startDow];
      return days.includes(dow);
    }
    case "MONTHLY": {
      const months = y * 12 + m - (startY * 12 + startM);
      if (months < 0 || months % rule.interval !== 0) return false;
      if (rule.byDay.length) {
        return rule.byDay.some((b) => {
          if (dowNumber(b.day) !== dow) return false;
          if (b.pos === 0) return true;
          const nth = Math.ceil(d / 7);
          const fromEnd = -Math.ceil((daysInMonth(y, m) - d + 1) / 7);
          return b.pos > 0 ? nth === b.pos : fromEnd === b.pos;
        });
      }
      const targets = rule.byMonthDay.length ? rule.byMonthDay : [startD];
      return targets.some((t) => (t > 0 ? t === d : daysInMonth(y, m) + t + 1 === d));
    }
  }
}

export type Slot = { start: number; end: number };
export type ExpandedRule = { firstStart: string; durationMinutes: number; rrule: string };
export type Expanded = { zone: string; rules: ExpandedRule[]; slots: Slot[] };

export type ScheduleInput = {
  timeZone: string;
  startDate: string;
  endDate: string;
  rules: { firstStart: string; durationMinutes: number; rrule: string }[];
};

/** Проверяет расписание и разворачивает его в занятия. */
export function expand(schedule: ScheduleInput): Expanded {
  const zone = zoneOf(schedule.timeZone);
  if (!schedule.rules?.length) throw badRequest("В расписании должно быть хотя бы одно правило");
  const start = parseDate(schedule.startDate);
  const end = parseDate(schedule.endDate);
  const startMs = Date.UTC(start.y, start.m - 1, start.d);
  const endMs = Date.UTC(end.y, end.m - 1, end.d);
  if (endMs < startMs) throw badRequest("Последний день серии не может быть раньше первого");
  if ((endMs - startMs) / DAY >= MAX_SERIES_DAYS) throw badRequest("Серия может длиться не больше года");
  const windowStart = zonedToMs(start.y, start.m, start.d, 0, 0, 0, zone);
  const windowEnd = zonedToMs(end.y, end.m, end.d + 1, 0, 0, 0, zone);

  const rules: ExpandedRule[] = [];
  const slots = new Map<number, Slot>();
  schedule.rules.forEach((request, i) => {
    const label = schedule.rules.length > 1 ? `Правило ${i + 1}: ` : "";
    const first = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(request.firstStart ?? "");
    if (!first) throw badRequest(message(label, "не удалось разобрать время первого занятия"));
    const [fy, fm, fd, fh, fmi, fs] = [+first[1], +first[2], +first[3], +first[4], +first[5], first[6] ? +first[6] : 0];
    const firstDayMs = Date.UTC(fy, fm - 1, fd);
    if (firstDayMs < startMs || firstDayMs > endMs) throw badRequest(message(label, "первое занятие должно попадать в границы серии"));
    if (!Number.isFinite(request.durationMinutes) || request.durationMinutes < 1) throw badRequest(message(label, "длительность должна быть больше нуля"));
    const rule = parseRule(request.rrule, label);
    rules.push({ firstStart: `${first[1]}-${first[2]}-${first[3]}T${pad2(fh)}:${pad2(fmi)}:${pad2(fs)}`, durationMinutes: request.durationMinutes, rrule: canonical(request.rrule) });
    const startDay = Math.round(firstDayMs / DAY);
    const startDow = ((new Date(firstDayMs).getUTCDay() + 6) % 7) + 1;
    let produced = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const dayMs = firstDayMs + step * DAY;
      const day = startDay + step;
      const dt = new Date(dayMs);
      const [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
      const dow = ((dt.getUTCDay() + 6) % 7) + 1;
      const at = zonedToMs(y, m, d, fh, fmi, fs, zone);
      if (at >= windowEnd) break;
      if (!matchesDay(rule, startDay, startDow, fy, fm, fd, day, y, m, d, dow)) continue;
      produced++;
      if (rule.count !== null && produced > rule.count) break;
      if (rule.until !== null && at > rule.until) break;
      if (at < windowStart) continue;
      if (!slots.has(at)) slots.set(at, { start: at, end: at + request.durationMinutes * 60_000 });
      if (slots.size > MAX_OCCURRENCES) throw badRequest(`В серии не может быть больше ${MAX_OCCURRENCES} занятий`);
    }
  });
  if (!slots.size) throw badRequest("По этому расписанию в границах серии нет ни одного занятия");
  return { zone, rules, slots: [...slots.values()].sort((a, b) => a.start - b.start) };
}

// ---------- описание словами ----------

const FALLBACK = "по расписанию";

export const plural = (n: number, one: string, few: string, many: string) => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  return mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
};

const DATIVE: Record<number, string> = { 1: "понедельникам", 2: "вторникам", 3: "средам", 4: "четвергам", 5: "пятницам", 6: "субботам", 7: "воскресеньям" };
const ACCUSATIVE: Record<number, string> = { 1: "понедельник", 2: "вторник", 3: "среду", 4: "четверг", 5: "пятницу", 6: "субботу", 7: "воскресенье" };

const joinRussian = (items: string[]) => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} и ${items[items.length - 1]}`);

function ordinalWord(pos: number, dow: number): string | null {
  const gender = [3, 5, 6].includes(dow) ? 1 : dow === 7 ? 2 : 0;
  const words = [
    ["первый", "первую", "первое"],
    ["второй", "вторую", "второе"],
    ["третий", "третью", "третье"],
    ["четвёртый", "четвёртую", "четвёртое"],
  ];
  let word: string;
  if (pos === -1) word = ["последний", "последнюю", "последнее"][gender];
  else if (pos >= 1 && pos <= 4) word = words[pos - 1][gender];
  else return null;
  return `в ${word} ${ACCUSATIVE[dow]} месяца`;
}

/** «по вторникам в 20:00», «по воскресеньям раз в 2 недели в 14:00». firstStart — «YYYY-MM-DDTHH:mm:ss». */
export function describeRule(firstStart: string, rrule: string): string {
  let rule: Rule;
  try {
    rule = parseRule(rrule);
  } catch {
    return FALLBACK;
  }
  for (const part of rule.parts) if (!SUPPORTED.has(part)) return FALLBACK;
  const [date, time] = firstStart.split("T");
  const { y, m, d } = parseDate(date);
  const startDow = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  let repeat: string | null = null;
  if (rule.freq === "DAILY") {
    if (!rule.byDay.length && !rule.byMonthDay.length) {
      repeat = rule.interval === 1 ? "каждый день" : rule.interval === 2 ? "через день" : `раз в ${rule.interval} ${plural(rule.interval, "день", "дня", "дней")}`;
    }
  } else if (rule.freq === "WEEKLY") {
    if (!rule.byMonthDay.length && !rule.byDay.some((b) => b.pos !== 0)) {
      const days = new Set(rule.byDay.length ? rule.byDay.map((b) => dowNumber(b.day)) : [startDow]);
      if (days.size === 7 && rule.interval === 1) repeat = "каждый день";
      else {
        const names = joinRussian([...days].sort((a, b) => a - b).map((n) => DATIVE[n]));
        const every = rule.interval === 1 ? "" : ` раз в ${rule.interval} ${plural(rule.interval, "неделю", "недели", "недель")}`;
        repeat = `по ${names}${every}`;
      }
    }
  } else if (rule.freq === "MONTHLY") {
    const every = rule.interval === 1 ? "каждый месяц" : `раз в ${rule.interval} ${plural(rule.interval, "месяц", "месяца", "месяцев")}`;
    if (rule.byDay.length && rule.byMonthDay.length) repeat = null;
    else if (rule.byDay.length) {
      if (rule.byDay.length === 1 && rule.byDay[0].pos !== 0) {
        const w = ordinalWord(rule.byDay[0].pos, dowNumber(rule.byDay[0].day));
        repeat = w ? `${every}, ${w}` : null;
      }
    } else {
      const days = rule.byMonthDay.length ? rule.byMonthDay : [d];
      repeat = days.some((n) => n < 1) ? null : `${every}, ${joinRussian([...days].sort((a, b) => a - b).map((n) => `${n}-го`))} числа`;
    }
  }
  return repeat === null ? FALLBACK : `${repeat} в ${time.slice(0, 5)}`;
}

export const describeRules = (rules: Record<string, any>[]) =>
  rules.map((r) => describeRule(r.firstStart, r.rrule)).join("; ");
