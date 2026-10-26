// Общие типы и помощники хендлеров мока: ошибки как у бэкенда (RFC 9457 ProblemDetail), разбор query, страницы.
import type { Row } from "./db";
import type { OperationId } from "./routes.gen";

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  501: "Not Implemented",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    /** Дополнительные поля ProblemDetail (например, errors по полям формы). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail);
  }

  body(instance: string) {
    return { detail: this.detail, instance, status: this.status, title: TITLES[this.status] ?? "Error", ...this.extra };
  }
}

export const badRequest = (detail: string) => new HttpError(400, detail);
export const unauthorized = (detail = "Требуется вход") => new HttpError(401, detail);
export const forbidden = (detail = "Недостаточно прав") => new HttpError(403, detail);
export const notFound = (detail = "Не найдено") => new HttpError(404, detail);
export const conflict = (detail: string) => new HttpError(409, detail);
export const notImplemented = (detail = "В демо-версии это недоступно") => new HttpError(501, detail);

/** Ответ с нестандартным статусом или без тела. По умолчанию статус берётся из спеки. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

export class Query {
  constructor(readonly params: URLSearchParams) {}

  str(key: string): string | undefined {
    const v = this.params.get(key);
    return v === null || v === "" || v === "null" ? undefined : v;
  }

  all(key: string): string[] {
    return this.params.getAll(key).filter((v) => v !== "");
  }

  int(key: string, fallback?: number): number | undefined {
    const v = this.str(key);
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  num(key: string): number | undefined {
    const v = this.str(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }

  bool(key: string): boolean | undefined {
    const v = this.str(key);
    return v === undefined ? undefined : v === "true";
  }

  has(key: string) {
    return this.params.has(key);
  }
}

export type Ctx = {
  op: OperationId;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Query;
  body: any;
  form: FormData | null;
  /** Текущий пользователь или null. */
  user: Row | null;
  now: number;
  /** Войти (userId) или выйти (null). */
  setSession(userId: string | null): void;
  /** Требует вход, иначе 401. */
  me(): Row;
};

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export const handlers: Partial<Record<OperationId, Handler>> = {};

export function defineHandlers(map: Partial<Record<OperationId, Handler>>) {
  Object.assign(handlers, map);
}

/** Постраничный ответ как у бэкенда: page с нуля, size не больше 100. */
export function pageOf<T>(all: T[], page: number | undefined, size: number | undefined, defaultSize = 20) {
  const s = Math.min(Math.max(size ?? defaultSize, 1), 100);
  const p = Math.max(page ?? 0, 0);
  return {
    items: all.slice(p * s, p * s + s),
    page: p,
    size: s,
    totalElements: all.length,
    totalPages: Math.ceil(all.length / s),
  };
}

export const pageParams = (q: Query, defaultSize = 20) => ({ page: q.int("page", 0), size: q.int("size", defaultSize) });

export function requireBody<T = any>(ctx: Ctx): T {
  if (ctx.body === null || ctx.body === undefined || typeof ctx.body !== "object") throw badRequest("Пустое тело запроса");
  return ctx.body as T;
}

// ---------- валидация формы (сообщения как у Hibernate Validator) ----------

export type FieldRule = {
  required?: boolean; notNull?: boolean; notEmpty?: boolean; min?: number; max?: number; email?: boolean; minValue?: number; maxValue?: number;
  /** Размер массива: @Size(max = N). */
  maxItems?: number;
};

/** Собирает ошибки полей по правилам (сообщения как у Hibernate Validator); prefix — путь вложенного объекта. */
export function collectErrors(body: any, rules: Record<string, FieldRule>, errors: Record<string, string> = {}, prefix = ""): Record<string, string> {
  for (const [field, rule] of Object.entries(rules)) {
    const key = prefix + field;
    const value = body?.[field];
    const blank = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if ((rule.required || rule.notNull || rule.notEmpty) && (value === undefined || value === null)) {
      errors[key] = rule.notNull ? "не должно равняться null" : "не должно быть пустым";
      continue;
    }
    if (rule.required && blank) {
      // при пустой строке и @Size(min) бэкенд отвечает про размер, а не про «пусто»
      errors[key] = typeof value === "string" && rule.min !== undefined && [...value].length < rule.min
        ? `размер должен находиться в диапазоне от ${rule.min} до ${rule.max ?? 2147483647}`
        : "не должно быть пустым";
      continue;
    }
    if (value === undefined || value === null) continue;
    if (rule.notEmpty && !Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0) {
      errors[key] = "не должно быть пустым";
      continue;
    }
    if (Array.isArray(value)) {
      if (rule.notEmpty && value.length === 0) errors[key] = "не должно быть пустым";
      else if (rule.maxItems !== undefined && value.length > rule.maxItems) errors[key] = `размер должен находиться в диапазоне от 0 до ${rule.maxItems}`;
      continue;
    }
    if (typeof value === "string") {
      const length = [...value].length;
      if ((rule.min !== undefined || rule.max !== undefined) && (length < (rule.min ?? 0) || length > (rule.max ?? Infinity))) {
        errors[key] = `размер должен находиться в диапазоне от ${rule.min ?? 0} до ${rule.max ?? 2147483647}`;
        continue;
      }
      if (rule.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[key] = "должно иметь формат адреса электронной почты";
    }
    if (typeof value === "number") {
      if (rule.minValue !== undefined && value < rule.minValue) errors[key] = `должно быть больше или равно ${rule.minValue}`;
      else if (rule.maxValue !== undefined && value > rule.maxValue) errors[key] = `должно быть меньше или равно ${rule.maxValue}`;
    }
  }
  return errors;
}

export function throwIfInvalid(errors: Record<string, string>) {
  const first = Object.values(errors)[0];
  if (first) throw new HttpError(400, first, { errors });
}

/** Проверяет поля тела по правилам; при ошибках — 400 с detail первой ошибки и errors по полям. */
export function check(body: any, rules: Record<string, FieldRule>) {
  throwIfInvalid(collectErrors(body, rules));
}
