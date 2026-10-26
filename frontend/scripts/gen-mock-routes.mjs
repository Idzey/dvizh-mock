// Таблица маршрутов мока из OpenAPI-спеки: метод, шаблон пути, operationId и код успешного ответа.
// Мок отвечает тем же статусом, что и настоящий бэкенд, а фронт по нему принимает решения (например, `status !== 201`).
//   yarn mock:routes
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const spec = JSON.parse(await readFile(new URL("../src/shared/api/schemas/openapi.json", import.meta.url), "utf8"));

const routes = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!op.operationId) continue;
    const success = Object.keys(op.responses ?? {})
      .filter((code) => code.startsWith("2"))
      .map(Number)
      .sort()[0];
    const keys = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    // `calendar.ics` и прочие точки в литералах экранируем
    const source = path.replace(/[.]/g, "\\.").replace(/\{\w+\}/g, "([^/]+)");
    routes.push({ method: method.toUpperCase(), path, source, keys, op: op.operationId, status: success ?? 200 });
  }
}
// Сначала маршруты с меньшим числом параметров: `/events/mine` раньше `/events/{id}`.
routes.sort((a, b) => a.keys.length - b.keys.length || b.path.length - a.path.length);

const lines = routes.map(
  (r) =>
    `  { method: "${r.method}", pattern: new RegExp(${JSON.stringify(`^${r.source}$`)}), keys: ${JSON.stringify(r.keys)}, op: "${r.op}", status: ${r.status}, path: "${r.path}" },`,
);
const out = `// Сгенерировано scripts/gen-mock-routes.mjs из openapi.json — не править руками (yarn mock:routes).
export const ROUTES = [
${lines.join("\n")}
] as const;

export type OperationId = (typeof ROUTES)[number]["op"];
export type RouteDef = (typeof ROUTES)[number];
`;
await writeFile(fileURLToPath(new URL("../src/mock/routes.gen.ts", import.meta.url)), out);
console.log(`mock routes: ${routes.length}`);
