// Время и часовые пояса. Мок живёт на epoch-миллисекундах; пояс нужен для «календарных дней» и локального времени серий.
export const ZONE = "Asia/Krasnoyarsk";
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

export type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number; dow: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string) => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(zone, f);
  }
  return f;
};

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Разложение момента на локальные части в поясе; dow — 1 (пн) … 7 (вс), как DayOfWeek в Java. */
export function partsIn(ms: number, zone: string = ZONE): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour),
    mi: Number(out.minute),
    s: Number(out.second),
    dow: WEEKDAYS[out.weekday] ?? 1,
  };
}

/** Смещение пояса (мс) в данный момент. */
export function offsetAt(ms: number, zone: string): number {
  const p = partsIn(ms, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Локальное время в поясе → момент. На границе перехода на летнее время выбирается более позднее. */
export function zonedToMs(y: number, m: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let ms = guess - offsetAt(guess, zone);
  ms = guess - offsetAt(ms, zone);
  return ms;
}

/** «2026-10-26T19:00:00» (настенное время без зоны) → момент в поясе. */
export function localToMs(local: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(local);
  if (!m) return Number.NaN;
  return zonedToMs(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, zone);
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Начало календарного дня в поясе. */
export function startOfDay(ms: number, zone: string = ZONE): number {
  const p = partsIn(ms, zone);
  return zonedToMs(p.y, p.m, p.d, 0, 0, 0, zone);
}

/** Начало дня со сдвигом на n дней (по календарю пояса). */
export function addDays(ms: number, days: number, zone: string = ZONE): number {
  const p = partsIn(ms, zone);
  return zonedToMs(p.y, p.m, p.d + days, p.h, p.mi, p.s, zone);
}

export const dateKey = (ms: number, zone: string = ZONE) => {
  const p = partsIn(ms, zone);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
};

export const timeText = (ms: number, zone: string = ZONE) => {
  const p = partsIn(ms, zone);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
};

export const dateText = (ms: number, zone: string = ZONE) => {
  const p = partsIn(ms, zone);
  return `${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
};

/** Месяц в виде индекса y*12+m — для сравнения «в этом месяце». */
export const monthKey = (ms: number, zone: string = ZONE) => {
  const p = partsIn(ms, zone);
  return p.y * 12 + (p.m - 1);
};

export const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Разбор «YYYY-MM-DD» в части. */
export function parseDate(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split("-").map(Number);
  return { y, m, d };
}
