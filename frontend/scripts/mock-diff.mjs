// Сверка мока с настоящим бэкендом: одинаковые запросы к обоим, структурное сравнение ответов.
// Мок запускается в Node через Vite SSR (ядро не знает про браузер), данные — из того же снапшота, поэтому id совпадают.
//   node scripts/mock-diff.mjs [фильтр по имени сценария] [--verbose]
// Нужен бэкенд на :8080 с теми же данными, из которых сделан снапшот (make back после export.mjs, без записей между ними).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.BACKEND_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const filter = args.find((a) => !a.startsWith("--"));

// ---------- мок ----------
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": `${root}src` } },
});
const dbModule = await vite.ssrLoadModule("/src/mock/db/index.ts");
const core = await vite.ssrLoadModule("/src/mock/core.ts");
dbModule.setSnapshotLoader(async () => JSON.parse(readFileSync(`${root}src/mock/seed/snapshot.json`, "utf8")));
await dbModule.boot();

const userIds = new Map();
for (const u of dbModule.db.users.rows) userIds.set(u.username, u.id);

export async function mock(user, method, path, body) {
  const id = user ? (userIds.get(user) ?? dbModule.db.users.rows.find((u) => u.username === user)?.id) : null;
  const res = await core.dispatch({ method, url: path, body, userId: id ?? null });
  return { status: res.status, body: res.text ? tryJson(res.text) : null, raw: res.text };
}

// ---------- настоящий бэкенд ----------
const jars = new Map();
async function login(user) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "accept-language": "ru" }, body: JSON.stringify({ username: user, password: "demo-password-1" }) });
  if (!res.ok) throw new Error(`login ${user}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  jars.set(user, { cookie, at: Date.now() });
  return cookie;
}

export async function real(user, method, path, body) {
  let jar = jars.get(user);
  if (user && (!jar || Date.now() - jar.at > 10 * 60_000)) jar = { cookie: await login(user) };
  const headers = { "accept-language": "ru", ...(jar ? { cookie: jar.cookie ?? jars.get(user).cookie } : {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? tryJson(text) : null, raw: text };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- нормализация ----------
const MAP = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const translit = (s) => s.replace(/[а-яё]/gi, (c) => MAP[c.toLowerCase()] ?? c);

function normString(s) {
  let out = s;
  out = out.replace(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z/g, (_, base, frac) => `${base}.${(frac ?? "").padEnd(3, "0").slice(0, 3)}Z`);
  out = out.replace(/\/media\/files\/([0-9a-f-]{36})\.[a-z]+/g, "/api/files/$1");
  out = out.replace(/\/(?:api|media)\/(sport-images|achievement-images)\/([^"\s]+)/g, (_, dir, file) => `IMG/${dir}/${translit(decodeURIComponent(file))}`);
  return out;
}

// поля-множества: порядок у бэкенда произвольный
const SET_KEYS = new Set(["categories", "channels", "days"]);

function norm(v, key) {
  if (key === "nextCursor") return "<cursor>";
  if (typeof v === "string") return normString(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => norm(x));
    return SET_KEYS.has(key) ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, k)]));
  return v;
}

export function diff(a, b, path = "$", out = [], opts = {}) {
  if (out.length > 40) return out;
  const ignore = opts.ignore ?? [];
  if (ignore.some((re) => re.test(path))) return out;
  if (a === b) return out;
  if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: длина ${a.length} (бэкенд) ≠ ${b.length} (мок)`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out, opts);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${path}.${k}: нет у бэкенда, у мока ${short(b[k])}`);
      else if (!(k in b)) out.push(`${path}.${k}: нет у мока, у бэкенда ${short(a[k])}`);
      else diff(a[k], b[k], `${path}.${k}`, out, opts);
    }
    return out;
  }
  out.push(`${path}: бэкенд ${short(a)} ≠ мок ${short(b)}`);
  return out;
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 90 ? `${s.slice(0, 90)}…` : s;
};


// ---------- близнецовые сценарии: одинаковые действия на обоих, новые id сопоставляются ----------
import { execFileSync } from "node:child_process";

const SCRATCH = process.env.MOCK_DIFF_SCRATCH;
const ctx = { real: {}, mock: {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let knownIds = new Set();
let pairIndex = new Map();

export async function resetBoth() {
  execFileSync("bash", [`${SCRATCH}/reset-real.sh`], { stdio: "pipe" });
  jars.clear();
  await dbModule.reseedForTests();
  userIds.clear();
  for (const u of dbModule.db.users.rows) userIds.set(u.username, u.id);
  knownIds = new Set();
  for (const table of Object.values(dbModule.db)) for (const row of table.rows) if (row.id) knownIds.add(row.id);
  ctx.real = {};
  ctx.mock = {};
  pairIndex = new Map();
}

const fill = (value, side) => {
  if (typeof value === "string") return value.replace(/\{(\w+)\}/g, (_, name) => ctx[side][name] ?? `{${name}}`);
  if (Array.isArray(value)) return value.map((v) => fill(v, side));
  if (value && typeof value === "object" && !(value instanceof FormData)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, side)]));
  return value;
};

function pick(body, expr) {
  let cur = body;
  for (const m of expr.replace(/^\$/, "").matchAll(/\.?(\w+)|\[(\d+)]/g)) cur = m[1] !== undefined ? cur?.[m[1]] : cur?.[Number(m[2])];
  return cur;
}

function autoPair(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    if (UUID.test(a) && UUID.test(b) && a !== b && !knownIds.has(a) && !knownIds.has(b)) {
      if (!pairIndex.has(a) && !pairIndex.has(b)) {
        const label = `<new${pairIndex.size / 2 + 1}>`;
        pairIndex.set(a, label);
        pairIndex.set(b, label);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) autoPair(a[i], b[i]);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(a)) if (k in b) autoPair(a[k], b[k]);
  }
}

const NOW_WINDOW = 20 * 60_000;
function relabel(v, now) {
  if (typeof v === "string") {
    let out = v;
    for (const [id, label] of pairIndex) if (out.includes(id)) out = out.replaceAll(id, label);
    out = out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (t) => (Math.abs(Date.parse(t) - now) < NOW_WINDOW ? "<now>" : t));
    // Instant.toString() в тексте уведомлений и ссылки на загруженные файлы
    out = out.replace(/\/api\/files\/([0-9a-f-]{36})/g, (m, id) => (knownIds.has(id) ? m : "<file>"));
    return out.replace(/\/media\/files\/[0-9a-f-]{36}\.[a-z]+|blob:[^"\s]+/g, "<file>").replace(/\/api\/files\/<new\d+>/g, "<file>");
  }
  if (Array.isArray(v)) return v.map((x) => relabel(x, now));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relabel(x, now)]));
  return v;
}

/** Один шаг: тот же запрос к обоим. save — {имя: "$.путь"} для следующих шагов. */
export async function step(label, user, method, path, body, opts = {}) {
  const now = Date.now();
  const [r, m] = await Promise.all([
    real(user, method, fill(path, "real"), fill(body, "real")),
    mock(user, method, fill(path, "mock"), fill(body, "mock")),
  ]);
  const problems = [];
  if (r.status !== m.status) {
    problems.push(`статус: бэкенд ${r.status}${r.body?.detail ? ` («${r.body.detail}»)` : ""} ≠ мок ${m.status}${m.body?.detail ? ` («${m.body.detail}»)` : ""}`);
  } else {
    const rb = opts.pick ? opts.pick(r.body) : r.body;
    const mb = opts.pick ? opts.pick(m.body) : m.body;
    autoPair(rb, mb);
    problems.push(...diff(relabel(norm(rb), now), relabel(norm(mb), now), "$", [], opts));
  }
  for (const [name, expr] of Object.entries(opts.save ?? {})) {
    ctx.real[name] = pick(r.body, expr);
    ctx.mock[name] = pick(m.body, expr);
  }
  const res = { name: `${user ?? "-"} ${method} ${fill(path, "real")}${label ? ` [${label}]` : ""} → ${r.status}`, problems, real: r, mock: m };
  report(res);
  return res;
}

// ---------- сценарии ----------
export const scenarios = [];
export const scenario = (name, fn) => scenarios.push({ name, fn });

export async function compare(name, user, method, path, body, opts = {}) {
  const [r, m] = await Promise.all([real(user, method, path, body), mock(user, method, path, body)]);
  const problems = [];
  if (r.status !== m.status) problems.push(`статус: бэкенд ${r.status} ≠ мок ${m.status}${m.body?.detail ? ` («${m.body.detail}»)` : ""}${r.body?.detail ? ` / бэкенд: «${r.body.detail}»` : ""}`);
  if (r.status === m.status) {
    const rb = norm(opts.pick ? opts.pick(r.body) : r.body);
    const mb = norm(opts.pick ? opts.pick(m.body) : m.body);
    problems.push(...diff(rb, mb, "$", [], opts));
  }
  return { name: `${user ?? "-"} ${method} ${path}${name ? ` [${name}]` : ""}`, problems, real: r, mock: m };
}

const results = { ok: 0, bad: 0 };
export function report(res) {
  if (!res.problems.length) {
    results.ok++;
    if (verbose) console.log(`  ✔ ${res.name}`);
    return;
  }
  results.bad++;
  console.log(`  ✖ ${res.name}`);
  for (const p of res.problems.slice(0, 12)) console.log(`      ${p}`);
  if (res.problems.length > 12) console.log(`      … ещё ${res.problems.length - 12}`);
}

export async function check(name, user, method, path, body, opts) {
  const res = await compare(name, user, method, path, body, opts);
  report(res);
  return res;
}

// сценарии лежат рядом: scripts/mock-diff/*.mjs
const { default: register } = await import("./mock-diff/scenarios.mjs");
register({ scenario, check, compare, real, mock, db: dbModule.db, step, resetBoth, ctx });
for (const file of readdirSync(new URL("./mock-diff/", import.meta.url)).filter((f) => /^flows.*\.mjs$/.test(f))) {
  const { default: registerFlows } = await import(`./mock-diff/${file}`);
  registerFlows({ scenario, step, resetBoth, real, mock, db: dbModule.db, ctx, check });
}

for (const s of scenarios) {
  if (filter && !s.name.includes(filter)) continue;
  console.log(`▶ ${s.name}`);
  try {
    await s.fn();
  } catch (error) {
    results.bad++;
    console.log(`  ✖ сценарий упал: ${error.stack ?? error}`);
  }
}
console.log(`\nИтого: ${results.ok} совпало, ${results.bad} с расхождениями`);
await vite.close();
process.exit(results.bad ? 1 : 0);
