// Дымовой прогон демо в настоящем браузере: вход, лента, карточка, запись, перезагрузка (данные не откатываются).
//   yarn build:mock && yarn preview --port 4173   затем   node scripts/mock-smoke.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4173";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || m.text().includes("[mock] 501")) problems.push(`${m.type()}: ${m.text()}`);
});
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    console.log(`✖ ${name}: ${e.message.split("\n")[0]}`);
    problems.push(name);
  }
};

await step("страница входа", async () => {
  await page.goto(`${base}/auth/login`, { waitUntil: "networkidle" });
  await page.getByText("Демо-аккаунты").waitFor({ timeout: 15000 });
});
await step("вход под anna", async () => {
  await page.getByLabel("Логин").fill("anna");
  await page.locator('input[type="password"]').first().fill("demo-password-1");
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 15000 });
});
await step("лента", async () => {
  await page.goto(`${base}/feed`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const cards = await page.locator("a[href^='/events/']").count();
  if (cards < 3) throw new Error(`карточек мало: ${cards}`);
});
let joined = "";
await step("карточка и запись", async () => {
  const hrefs = await page.locator("a[href^='/events/']").evaluateAll((a) => [...new Set(a.map((x) => x.getAttribute("href")))].slice(0, 12));
  for (const href of hrefs) {
    await page.goto(`${base}${href}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const button = page.getByRole("button", { name: /^(записаться|подать заявку)$/i });
    if (await button.count()) {
      await button.first().click();
      await page.waitForTimeout(1500);
      joined = href;
      return;
    }
  }
  throw new Error("нет встречи, на которую можно записаться");
});
await step("после перезагрузки запись на месте", async () => {
  await page.goto(`${base}${joined}`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  if (await page.getByRole("button", { name: /^(записаться|подать заявку)$/i }).count()) throw new Error("запись откатилась");
});
for (const route of ["/", "/profile", "/blog", "/activity", "/orgs", "/pet"]) {
  await step(`маршрут ${route}`, async () => {
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    if (page.url().includes("/auth/login")) throw new Error("выкинуло на вход");
  });
}
await page.screenshot({ path: process.env.SMOKE_SHOT ?? "smoke.png" });
await browser.close();
console.log(problems.length ? `\nПроблемы (${problems.length}):\n${[...new Set(problems)].slice(0, 20).join("\n")}` : "\nБез ошибок");
process.exit(problems.length ? 1 : 0);
