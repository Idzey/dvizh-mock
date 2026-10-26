#!/usr/bin/env node
// Снапшот демо-данных для мока (docs/mock.md): таблицы Postgres -> frontend/src/mock/seed/snapshot.json,
// файлы с бэкенда -> frontend/public/media. Нужны `make dev` и `make back` (DEMO_MODE) с досеянными данными.
//   node scripts/mock-snapshot/export.mjs            выгрузить сейчас
//   node scripts/mock-snapshot/export.mjs --wait     сначала дождаться, пока счётчики таблиц перестанут расти
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const front = join(root, 'frontend')
const BASE = process.env.BACKEND_URL ?? 'http://localhost:8080'
const MAIN = ['admin', 'anna', 'petr', 'olga', 'dmitry', 'elena', 'sergey', 'nikolai', 'vika', 'ladya', 'enisey', 'yoga', 'bobry']

/** Таблицы, которых в моке нет: сессии, доставка во внешние каналы, служебное. */
const DROP_TABLES = new Set([
  'refresh_tokens', 'notification_deliveries', 'notification_reminders', 'telegram_bindings',
  'telegram_link_tokens', 'telegram_rate_limits', 'telegram_update_receipts', 'flyway_schema_history', 'spatial_ref_sys', 'geometry_columns', 'geography_columns',
])
const DROP_COLUMNS = { users: ['password_hash'], files: ['object_key'] }

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
const psql = (sql) =>
  execFileSync(
    'docker',
    ['compose', '-f', 'docker-compose.dev.yml', 'exec', '-T', '-e', 'PGTZ=UTC', '-e', 'PGCLIENTENCODING=UTF8',
      'db', 'psql', '-U', 'app', '-d', 'app', '-At', '-v', 'ON_ERROR_STOP=1'],
    { cwd: root, input: sql, encoding: 'utf8', maxBuffer: 1 << 30 },
  ).trim()
const json = (sql) => JSON.parse(psql(sql) || 'null')

const counts = () =>
  psql(`select (select count(*) from events)||','||(select count(*) from registrations)||','||(select count(*) from files)||','||(select count(*) from coin_ledger)||','||(select count(*) from users)`)

if (process.argv.includes('--wait')) {
  let prev = '', since = Date.now()
  for (;;) {
    let cur = ''
    try { cur = counts() } catch { /* БД ещё не готова или таблиц нет */ }
    if (cur !== prev) { prev = cur; since = Date.now(); console.log('счётчики:', cur) }
    const parts = cur.split(',').map(Number)
    if (parts[0] > 100 && parts[3] > 0 && Date.now() - since > 45_000) break
    await new Promise((r) => setTimeout(r, 5000))
  }
}

// --- схема ---
const cols = json(`select jsonb_agg(q) from (
  select table_name t, column_name c, data_type d, udt_name u, is_generated g
  from information_schema.columns where table_schema='public' order by table_name, ordinal_position) q`)
const byTable = new Map()
for (const { t, c, d, u, g } of cols) {
  if (DROP_TABLES.has(t)) continue
  if (g === 'ALWAYS' || u === 'geometry' || u === 'geography') continue
  if (DROP_COLUMNS[t]?.includes(c)) continue
  if (!byTable.has(t)) byTable.set(t, [])
  byTable.get(t).push({ c, d })
}

const schema = {}
const tables = {}
for (const [t, list] of byTable) {
  schema[t] = { instants: [], dates: [], localDateTimes: [] }
  const exprs = list.map(({ c, d }) => {
    const key = camel(c)
    if (d === 'timestamp with time zone') { schema[t].instants.push(key); return `floor(extract(epoch from "${c}")*1000)::bigint as "${key}"` }
    if (d === 'date') { schema[t].dates.push(key); return `to_char("${c}",'YYYY-MM-DD') as "${key}"` }
    if (d === 'timestamp without time zone') { schema[t].localDateTimes.push(key); return `to_char("${c}",'YYYY-MM-DD"T"HH24:MI:SS') as "${key}"` }
    return `"${c}" as "${key}"`
  })
  let where = ''
  const names = new Set(list.map((x) => x.c))
  const usersMain = `(select id from users where username in (${MAIN.map((m) => `'${m}'`).join(',')}))`
  if (['notifications', 'notification_inboxes', 'notification_settings'].includes(t) && names.has('user_id')) where = `where user_id in ${usersMain}`
  tables[camel(t)] = json(`select coalesce(jsonb_agg(r),'[]'::jsonb) from (select ${exprs.join(', ')} from "${t}" ${where}) r`)
  console.log(`${t}: ${tables[camel(t)].length}`)
}
const schemaCamel = Object.fromEntries(Object.entries(schema).map(([k, v]) => [camel(k), v]))

const exportedAt = Number(psql('select (extract(epoch from now())*1000)::bigint'))

// --- файлы ---
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
const filesDir = join(front, 'public', 'media', 'files')
mkdirSync(filesDir, { recursive: true })
let cookie = ''
const login = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo-password-1' }),
  })
  if (!res.ok) throw new Error(`login ${res.status}`)
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
await login()
const fileRows = tables.files ?? []
let done = 0, failed = 0
const queue = [...fileRows]
const worker = async () => {
  for (let f; (f = queue.shift()); ) {
    const ext = EXT[f.contentType] ?? 'bin'
    const target = join(filesDir, `${f.id}.${ext}`)
    if (existsSync(target)) { done++; continue }
    for (let attempt = 0; attempt < 3; attempt++) {
      let res = await fetch(`${BASE}/api/files/${f.id}`, { headers: { cookie } })
      if (res.status === 401) { await login(); res = await fetch(`${BASE}/api/files/${f.id}`, { headers: { cookie } }) }
      if (res.ok) { writeFileSync(target, Buffer.from(await res.arrayBuffer())); done++; break }
      if (attempt === 2) { failed++; console.warn(`файл ${f.id}: ${res.status}`) }
    }
    if (done % 100 === 0) console.log(`файлы: ${done}/${fileRows.length}`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
console.log(`файлы: ${done} скачано, ${failed} с ошибкой`)

// --- статика бэкенда, заданная в Java константами: комплекты бобра ---
const asAnna = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'anna', password: 'demo-password-1' }),
})
const annaCookie = asAnna.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const bundles = (await (await fetch(`${BASE}/api/pets/shop/bundles`, { headers: { cookie: annaCookie } })).json())
  .map(({ code, label, category, outfit, activity }) => ({ code, label, category, outfit, activity }))
console.log(`комплекты бобра: ${bundles.length}`)

// --- картинки видов спорта и достижений, словари модерации, лицензии ---
const res = join(root, 'backend', 'src', 'main', 'resources')
const MAP = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
const translit = (s) => s.replace(/[а-яё]/gi, (ch) => MAP[ch.toLowerCase()] ?? ch)
const sportImages = {}
for (const dir of ['sport-images', 'achievement-images']) {
  mkdirSync(join(front, 'public', 'media', dir), { recursive: true })
  for (const name of readdirSync(join(res, dir))) {
    const out = translit(name)
    copyFileSync(join(res, dir, name), join(front, 'public', 'media', dir, out))
    if (dir === 'sport-images') sportImages[name.replace(/\.webp$/, '')] = out
  }
}
mkdirSync(join(front, 'src', 'mock', 'moderation'), { recursive: true })
for (const name of readdirSync(join(res, 'moderation'))) copyFileSync(join(res, 'moderation', name), join(front, 'src', 'mock', 'moderation', name))
const credits = join(res, 'demo-photos', 'CREDITS.md')
if (existsSync(credits)) copyFileSync(credits, join(front, 'public', 'media', 'CREDITS.md'))

// --- результат ---
const body = { exportedAt, schema: schemaCamel, sportImages, bundles, tables }
const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)
mkdirSync(join(front, 'src', 'mock', 'seed'), { recursive: true })
const out = join(front, 'src', 'mock', 'seed', 'snapshot.json')
writeFileSync(out, JSON.stringify({ version, ...body }))
writeFileSync(join(front, 'src', 'mock', 'seed', 'snapshot.meta.json'), JSON.stringify({ version, exportedAt }))
console.log(`✔ ${out} (версия ${version}, exportedAt ${new Date(exportedAt).toISOString()})`)
