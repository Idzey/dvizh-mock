// Сдвиг времени данных на целое число недель: «сейчас» в моке настоящее, а мир каждый раз подтягивается к нему.
// Недели, а не дни: день недели и время суток сохраняются, поэтому серии по RRULE (BYDAY) остаются на своих днях.
import type { Row } from "./table";

export const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export type TableSchema = { instants: string[]; dates: string[]; localDateTimes: string[] };
export type SnapshotSchema = Record<string, TableSchema>;

/** Сколько целых недель надо добавить: не больше, чем прошло с якоря, и не больше, чем с последней записи пользователя. */
export const weeksToShift = (now: number, anchor: number, lastUserWriteAt: number) =>
  Math.max(0, Math.min(Math.floor((now - anchor) / WEEK_MS), Math.floor((now - lastUserWriteAt) / WEEK_MS)));

const pad = (n: number) => String(n).padStart(2, "0");

const shiftDate = (value: string, days: number) => {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const shiftMonths = (value: string, months: number) => {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const shiftLocal = (value: string, days: number) => {
  // «2026-10-26T19:00:00» — настенное время без зоны; прибавляем сутки, не трогая часы
  const [date, time] = value.split("T");
  return `${shiftDate(date, days)}T${time}`;
};

const monthIndex = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** Тексты уведомлений содержат даты вида «26.10.2026 19:00». Сдвигаем и их. */
const TEXT_DATE = /\b(\d{2})\.(\d{2})\.(\d{4})\b/g;
const shiftTextDates = (text: string, days: number) =>
  text.replace(TEXT_DATE, (_, dd: string, mm: string, yyyy: string) => {
    const shifted = shiftDate(`${yyyy}-${mm}-${dd}`, days);
    const [y, m, d] = shifted.split("-");
    return `${d}.${m}.${y}`;
  });

/**
 * Сдвигает все временные поля на `weeks` недель (на месте). Периоды «Организации месяца» сдвигаются на целые месяцы
 * между месяцем якоря и месяцем нового якоря, чтобы «прошлый месяц» оставался прошлым.
 */
export function shiftTables(tables: Record<string, Row[]>, schema: SnapshotSchema, weeks: number, anchor: number) {
  if (weeks <= 0) return;
  const ms = weeks * WEEK_MS;
  const days = weeks * 7;
  const months = monthIndex(anchor + ms) - monthIndex(anchor);
  for (const [name, rows] of Object.entries(tables)) {
    const spec = schema[name];
    if (!spec) continue;
    for (const row of rows) {
      for (const f of spec.instants) if (typeof row[f] === "number") row[f] += ms;
      for (const f of spec.dates) {
        if (typeof row[f] !== "string") continue;
        row[f] = name === "organizationAwards" && f === "period" ? shiftMonths(row[f], months) : shiftDate(row[f], days);
      }
      for (const f of spec.localDateTimes) if (typeof row[f] === "string") row[f] = shiftLocal(row[f], days);
    }
  }
  for (const n of tables.notifications ?? []) {
    if (typeof n.body === "string") n.body = shiftTextDates(n.body, days);
    if (typeof n.title === "string") n.title = shiftTextDates(n.title, days);
  }
}

export { DAY_MS };
