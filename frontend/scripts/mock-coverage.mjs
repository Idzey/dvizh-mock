// Покрытие мока: какие операции из openapi.json не имеют хендлера. Падает, если не хватает операции, которую использует фронт.
//   yarn mock:coverage
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const spec = JSON.parse(await readFile(path.join(root, "src/shared/api/schemas/openapi.json"), "utf8"));
const operations = [];
for (const item of Object.values(spec.paths)) for (const op of Object.values(item)) if (op.operationId) operations.push(op.operationId);

const handlersDir = path.join(root, "src/mock/handlers");
const handled = new Set();
for (const file of await readdir(handlersDir)) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const text = await readFile(path.join(handlersDir, file), "utf8");
  for (const m of text.matchAll(/^\s{2}([a-z]+(?:_[A-Za-z]+)?):/gm)) handled.add(m[1]);
}

// какие операции использует приложение вне сгенерированного клиента
const used = new Set();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full.includes(path.join("src", "shared", "api", "generated")) || full.includes(path.join("src", "mock"))) continue;
      await walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      const text = await readFile(full, "utf8");
      for (const op of operations) {
        const [tag, action] = op.split("_");
        const fn = action ? tag + action[0].toUpperCase() + action.slice(1) : tag;
        const hook = `use${fn[0].toUpperCase()}${fn.slice(1)}`;
        if (text.includes(hook) || new RegExp(`\\b${fn}\\b`).test(text) || text.includes(`get${fn[0].toUpperCase()}${fn.slice(1)}QueryKey`)) used.add(op);
      }
    }
  }
}
await walk(path.join(root, "src"));

const missing = operations.filter((op) => !handled.has(op));
const missingUsed = missing.filter((op) => used.has(op));
const extra = [...handled].filter((op) => !operations.includes(op));
console.log(`Операций в спеке: ${operations.length}, хендлеров: ${handled.size}, используется фронтом: ${used.size}`);
if (extra.length) console.log(`Лишние хендлеры (нет в спеке): ${extra.join(", ")}`);
if (missing.length) {
  console.log(`\nНет хендлера (${missing.length}):`);
  const byTag = {};
  for (const op of missing) (byTag[op.split("_")[0]] ??= []).push(`${op}${used.has(op) ? " *" : ""}`);
  for (const [tag, ops] of Object.entries(byTag)) console.log(`  ${tag}: ${ops.join(", ")}`);
  console.log("\n  * — операцию использует фронт");
}
if (missingUsed.length) process.exit(1);
console.log(missing.length ? "\nНе покрыты только неиспользуемые операции." : "\nПокрыто всё.");
