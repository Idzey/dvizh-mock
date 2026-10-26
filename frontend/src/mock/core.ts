// Ядро мока: запрос -> маршрут по таблице из openapi.json -> хендлер -> JSON-ответ. Про axios и браузер ничего не знает,
// поэтому то же ядро гоняется в Node (scripts/mock-diff) против настоящего бэкенда.
import { blobUrls, boot, db, meta } from "./db";
import { HttpError, Query, Reply, handlers, notImplemented, unauthorized, type Ctx } from "./http";
import { ROUTES, type OperationId } from "./routes.gen";
import "./handlers";
import { runJobs } from "./life";
import { commitChanges, discardChanges } from "./services/changes";

export type MockRequest = {
  method: string;
  /** Путь с query: `/api/events?size=5`. */
  url: string;
  body?: unknown;
  /** Кто вошёл: id пользователя из сессии (cookie или localStorage). */
  userId: string | null;
};

export type MockResponse = {
  status: number;
  /** Готовое тело (JSON-строка или текст); пустая строка — без тела. */
  text: string;
  contentType: string;
  /** Новая сессия, если запрос её поменял: id — войти, null — выйти, undefined — без изменений. */
  userId: string | null | undefined;
};

/** Эти операции доступны без входа. */
const PUBLIC: ReadonlySet<OperationId> = new Set<OperationId>([
  "auth_login", "auth_register", "auth_refresh", "auth_logout", "auth_checkUsername", "auth_checkEmail",
  "demo_accounts", "ping",
]);

const FILE_URL = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Ссылки на файлы в ответах хранятся в виде бэкенда (`/api/files/{id}`), наружу отдаются статикой или blob URL. */
export const rewriteFileUrls = (text: string) =>
  text.replace(FILE_URL, (whole, id: string) => {
    const blob = blobUrls.get(id);
    if (blob) return blob;
    const ext = meta.seedFiles[id];
    return ext ? `/media/files/${id}.${ext}` : whole;
  });

function match(method: string, pathname: string) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1])));
    return { route, params };
  }
  return null;
}

export async function dispatch(req: MockRequest): Promise<MockResponse> {
  await boot();
  runJobs(Date.now());

  const url = new URL(req.url, "http://mock.local");
  const method = req.method.toUpperCase();
  const found = match(method, url.pathname);
  let session: string | null | undefined;

  const fail = (error: HttpError): MockResponse => ({
    status: error.status,
    text: JSON.stringify(error.body(url.pathname)),
    contentType: "application/problem+json",
    userId: session,
  });

  if (!found) {
    console.warn(`[mock] 501 ${method} ${url.pathname}${url.search}`);
    return fail(notImplemented());
  }

  const { route, params } = found;
  const user = req.userId ? (db.users.get(req.userId) ?? null) : null;
  const ctx: Ctx = {
    op: route.op,
    method,
    path: url.pathname,
    params,
    query: new Query(url.searchParams),
    body: req.body instanceof FormData ? null : (req.body ?? null),
    form: req.body instanceof FormData ? req.body : null,
    user,
    now: Date.now(),
    setSession: (id) => {
      session = id;
    },
    me: () => {
      if (!user) throw unauthorized();
      return user;
    },
  };

  // отказ фильтра безопасности (нет входа, не админ) у бэкенда — пустое тело, не ProblemDetail
  if (!PUBLIC.has(route.op) && !user) return { status: 401, text: "", contentType: "application/json", userId: session };
  if (route.op.startsWith("admin_") && user?.systemRole !== "ADMIN") return { status: 403, text: "", contentType: "application/json", userId: session };

  try {
    const handler = handlers[route.op];
    if (!handler) {
      console.warn(`[mock] 501 нет хендлера ${route.op}`);
      throw notImplemented();
    }
    const out = await handler(ctx);
    commitChanges(ctx.now);
    const reply = out instanceof Reply ? out : new Reply(route.status, out);
    const body = reply.body;
    const isText = typeof body === "string";
    return {
      status: reply.status,
      text: body === undefined || body === null || reply.status === 204 ? "" : isText ? (body as string) : rewriteFileUrls(JSON.stringify(body)),
      contentType: isText ? "text/plain; charset=utf-8" : "application/json",
      userId: session,
    };
  } catch (error) {
    discardChanges();
    if (error instanceof HttpError) return fail(error);
    console.error(`[mock] ошибка в ${route.op}`, error);
    return {
      status: 500,
      text: JSON.stringify({ detail: "Внутренняя ошибка демо-версии", instance: url.pathname, status: 500, title: "Internal Server Error" }),
      contentType: "application/problem+json",
      userId: session,
    };
  }
}
