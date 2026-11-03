// Lint de cobertura i18n: toda chave usada no painel precisa existir em PT, EN e ES.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const source = read("i18n.js");
const injected = source.replace("window.RUNE_I18N = {", "window.__PACKS = DICT;\n  window.RUNE_I18N = {");
if (injected === source) {
  console.error("i18n.js: não foi possível expor DICT para o lint.");
  process.exit(1);
}
const context = { window: {} };
vm.runInNewContext(injected, context);
const packs = context.window.__PACKS;
const i18n = context.window.RUNE_I18N;
const langs = ["pt", "en", "es"];

const used = new Map();
const collect = (text, pattern, label) => {
  for (const match of text.matchAll(pattern)) {
    if (!used.has(match[1])) used.set(match[1], new Set());
    used.get(match[1]).add(label);
  }
};
collect(read("app.js"), /\btr\(\s*["']([A-Za-z0-9_.-]+)["']/g, "app.js");
collect(read("index.html"), /data-i18n="([A-Za-z0-9_.-]+)"/g, "index.html");

const problems = [];

for (const [key, places] of used) {
  for (const lang of langs) {
    if (!Object.prototype.hasOwnProperty.call(packs[lang], key)) {
      problems.push(`falta ${lang}: ${key} (${[...places].join(", ")})`);
    }
  }
}

for (const lang of langs.filter((l) => l !== "pt")) {
  for (const key of Object.keys(packs[lang])) {
    if (!Object.prototype.hasOwnProperty.call(packs.pt, key)) {
      problems.push(`órfã ${lang}: ${key} não existe em pt`);
    }
  }
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const key of Object.keys(packs.pt)) {
  const base = placeholders(packs.pt[key]);
  for (const lang of langs.filter((l) => l !== "pt")) {
    const other = packs[lang][key];
    if (other !== undefined && placeholders(other) !== base) {
      problems.push(`variáveis divergentes ${lang}: ${key} (${base} vs ${placeholders(other)})`);
    }
  }
}

if (i18n.t("en", "fleet.probedAgo", { age: "3 min" }) !== "probed 3 min ago") {
  problems.push('interpolação quebrada em en: fleet.probedAgo');
}
if (i18n.t("pt", "chave.inexistente") !== "chave.inexistente") {
  problems.push("fallback de chave inexistente deveria devolver a própria chave");
}

if (problems.length) {
  console.error(`i18n: ${problems.length} problema(s)`);
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`i18n ok · ${used.size} chaves em ${langs.length} idiomas · ${Object.keys(packs.pt).length} entradas por pack`);
