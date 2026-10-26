// Модерация текстов при сохранении (порт TextNormalizer, ProfanityFilter и ContentGuard).
// Мат не даёт сохранить (400); грубость, угрозы и спам сохраняются, но попадают в очередь администратора.
// Нейросеть и классификатор в демо недоступны — остаётся словарь, как у бэкенда с выключенными моделями.
import allowlistText from "../moderation/allowlist.txt?raw";
import obsceneText from "../moderation/obscene.txt?raw";
import rudeText from "../moderation/rude.txt?raw";
import sexualText from "../moderation/sexual.txt?raw";
import threatText from "../moderation/threat.txt?raw";
import { db, type Row } from "../db";
import { badRequest } from "../http";
import { newId } from "../util/ids";

const COMMENT_REJECTED = "Сообщение не отправлено: уберите нецензурные слова";

// ---------- нормализация ----------

const LOOKALIKES: Record<string, string> = {
  a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", n: "п", o: "о", p: "р", r: "г", t: "т", u: "и", x: "х", y: "у",
  "0": "о", "3": "з", "4": "ч", "6": "б", "9": "я", "@": "а", $: "с",
};
const TOKEN = /[\p{L}\p{N}@$*]+/gu;
const SPACED = /(?<![\p{L}\p{N}])\p{L}(?:[\s.,\-_*+|/\\~]+\p{L}(?![\p{L}\p{N}])){2,}/gu;
const MASKED_VOWELS = ["а", "е", "и", "о", "у", "ы", "я", "ю"];
const REPEATS = /(\p{L})\1{2,}/gu;
const hasCyrillic = (s: string) => /[Ѐ-ӿ]/u.test(s);

const joinSpaced = (text: string) => text.replace(SPACED, (m) => m.replace(/[^\p{L}]/gu, ""));
const cyrillize = (text: string) =>
  text.replace(TOKEN, (token) => (hasCyrillic(token) ? [...token].map((c) => LOOKALIKES[c] ?? c).join("") : token));
const unmask = (text: string) => (text.includes("*") ? [text.replaceAll("*", ""), ...MASKED_VOWELS.map((v) => text.replaceAll("*", v))] : [text]);
const collapseRepeats = (text: string, keep: number) => text.replace(REPEATS, (_, c: string) => c.repeat(keep));

export function variants(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return [];
  const lower = text.toLowerCase().replaceAll("ё", "е");
  const joined = joinSpaced(lower);
  const out = new Set<string>([lower, joined]);
  for (const unmasked of unmask(cyrillize(joined))) {
    out.add(unmasked);
    out.add(collapseRepeats(unmasked, 1));
    out.add(collapseRepeats(unmasked, 2));
  }
  return [...out];
}

// ---------- словарь ----------

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const BEFORE = "(?<![\\p{L}\\p{N}])(";
const AFTER = ")(?![\\p{L}\\p{N}])";
const dictionary = (roots: string[]) => new RegExp(BEFORE + roots.join("|") + AFTER, "giu");

const obscene = dictionary(lines(obsceneText));
const rude = dictionary(lines(rudeText));
const sexual = dictionary(lines(sexualText));
const threat = dictionary(lines(threatText));
const allowed = new RegExp(`^(?:${lines(allowlistText).join("|")})$`, "iu");

const LINK = /(?:https?:\/\/|www\.|t\.me\/|wa\.me\/|vk\.(?:com|cc)\/|bit\.ly\/|@[a-z0-9_]{5,})/giu;
const PHONE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/gu;
const wordsOf = (parts: string[]) => new RegExp(BEFORE + parts.join("|") + AFTER, "iu");
const PROMO = wordsOf([
  "заработ\\p{L}*", "доход\\p{L}*", "казино", "ставк\\p{L}*", "букмекер\\p{L}*", "крипт\\p{L}*", "инвестиц\\p{L}*",
  "промокод\\p{L}*", "скидк\\p{L}*", "акци[яи]", "подпис[ыа]\\p{L}*", "переходи\\p{L}*", "пиши(?:те)?", "в\\s+(?:лс|личку)",
  "бесплатн\\p{L}*", "прода[мюеё]\\p{L}*", "купи(?:те)?",
]);
const MONEY = wordsOf([
  "заработ\\p{L}*", "доход\\p{L}*", "казино", "ставк\\p{L}*", "букмекер\\p{L}*", "крипт\\p{L}*", "инвестиц\\p{L}*",
  "депозит\\p{L}*", "без\\s+вложени\\p{L}*", "пассивн\\p{L}*", "трейдинг\\p{L}*", "кэшбэк\\p{L}*", "микрозайм\\p{L}*", "займ\\p{L}*",
]);
const CONTACT = wordsOf([
  "пиши(?:те)?", "в\\s+(?:лс|личку|личные)", "ссылк\\p{L}*\\s+в\\s+(?:профиле|био|шапке)", "переходи\\p{L}*", "подписыв\\p{L}*", "подпишись", "жми",
]);

function first(pattern: RegExp, text: string | null | undefined): string | null {
  for (const variant of variants(text)) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(variant); m; m = pattern.exec(variant)) {
      if (!allowed.test(m[0])) return m[0];
      if (m[0] === "") pattern.lastIndex++;
    }
  }
  return null;
}

export const obsceneWord = (text: string | null | undefined) => first(obscene, text);

type Finding = { category: string; fragment: string; severity: number };

export function softSignals(text: string, spamRules: boolean): Finding[] {
  const out: Finding[] = [];
  const insult = first(rude, text);
  if (insult) out.push({ category: "INSULT", fragment: insult, severity: 1 });
  const sex = first(sexual, text);
  if (sex) out.push({ category: "SEXUAL", fragment: sex, severity: 2 });
  const threats = first(threat, text);
  if (threats) out.push({ category: "THREAT", fragment: threats, severity: 2 });
  if (spamRules && text) {
    const links = (text.match(LINK)?.length ?? 0) + (text.match(PHONE)?.length ?? 0);
    const money = first(new RegExp(MONEY.source, "giu"), text);
    const promo = PROMO.exec(text);
    if (money && (links >= 1 || first(new RegExp(CONTACT.source, "giu"), text))) {
      out.push({ category: "SPAM", fragment: money, severity: 3 });
    } else if (links >= 2 || (links >= 1 && promo)) {
      out.push({ category: "SPAM", fragment: promo ? promo[0] : "ссылки и контакты", severity: 1 });
    }
  }
  return out;
}

// ---------- ContentGuard ----------

export type Target = "COMMENT" | "EVENT" | "USER_PROFILE" | "ORGANIZATION";

/** Поля формы «подпись → текст». */
export const fields = (...labelsAndTexts: (string | null | undefined)[]): [string, string | null | undefined][] => {
  const out: [string, string | null | undefined][] = [];
  for (let i = 0; i + 1 < labelsAndTexts.length; i += 2) out.push([labelsAndTexts[i] as string, labelsAndTexts[i + 1]]);
  return out;
};

/** Текст для админа: «Подпись: значение» по строкам, пустые поля опущены. */
export const snapshotText = (list: [string, string | null | undefined][]) =>
  list.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${(v as string).trim()}`).join("\n");

/** Поля формы: первое поле с матом — 400 с его названием. */
export function requireClean(list: [string, string | null | undefined][]) {
  for (const [label, text] of list) if (obsceneWord(text)) throw badRequest(`Уберите нецензурные слова из поля «${label}»`);
}

/** Сообщение обсуждения: с матом — 400. */
export function requireCleanComment(text: string | null | undefined) {
  if (obsceneWord(text)) throw badRequest(COMMENT_REJECTED);
}

/** Поставить текст на проверку. Тот же текст повторно не проверяется (в том числе уже решённый админом). */
export function submit(target: Target, targetId: string, eventId: string | null, authorId: string | null, snapshot: string, now = Date.now()) {
  if (!snapshot || !snapshot.trim()) return;
  const existing = db.moderationChecks.find((c) => c.targetType === target && c.targetId === targetId);
  if (existing && existing.textSnapshot === snapshot) return;
  const findings = softSignals(snapshot, target === "COMMENT");
  const found = findings.length > 0;
  const categories = [...new Set(findings.map((f) => f.category))];
  const explanation = found ? `Словарь: ${[...new Set(findings.map((f) => `«${f.fragment}»`))].join(", ")}` : null;
  const severity = found ? Math.max(...findings.map((f) => f.severity)) : 0;
  const check =
    existing ??
    db.moderationChecks.insert({
      id: newId(), source: null, status: "CLEAN", eventId, attempts: 0, authorId, decision: null, severity: 0, targetId,
      checkedAt: null, createdAt: now, updatedAt: now, reviewedAt: null, targetType: target, explanation: null,
      reviewedById: null, textSnapshot: snapshot, categories: [],
    });
  Object.assign(check, {
    textSnapshot: snapshot, authorId, status: found ? "FLAGGED" : "CLEAN", categories, severity, explanation,
    source: found ? "HEURISTIC" : null, checkedAt: now, attempts: 0, reviewedAt: null, reviewedById: null, decision: null, updatedAt: now,
  });
  db.moderationChecks.touch();
}

/** Текста больше нет (автор удалил сообщение): проверка из очереди убирается. */
export function withdraw(target: Target, targetId: string) {
  db.moderationChecks.removeWhere((c) => c.targetType === target && c.targetId === targetId);
}

/** Админ принял меру сам: проверка в очереди закрывается. */
export function resolve(target: Target, targetId: string, decision: string, adminId: string, now = Date.now()) {
  const check = db.moderationChecks.find(
    (c) => c.targetType === target && c.targetId === targetId && ["FLAGGED", "AUTO_HIDDEN", "PENDING"].includes(c.status),
  );
  if (!check) return;
  Object.assign(check, { status: "RESOLVED", decision, reviewedAt: now, reviewedById: adminId, updatedAt: now });
  db.moderationChecks.touch();
}

export type { Row };
