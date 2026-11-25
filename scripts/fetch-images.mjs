// Downloads REAL photographs (no AI images) from Wikimedia Commons for seed data,
// stores them locally in /public/images and writes license attributions to CREDITS.json.
// Usage: node scripts/fetch-images.mjs
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("public/images");
const UA = "PamarcyStoreSeed/1.0 (pharmacy demo seed; contact: dev@pamarcy.local)";
const queries = JSON.parse(readFileSync("scripts/image-queries.json", "utf8"));
const creditsPath = path.join(OUT, "CREDITS.json");
const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, "utf8")) : {};

const strip = (h = "") => {
  let prev = "";
  let cur = String(h);
  while (cur !== prev) { prev = cur; cur = cur.replace(/<[^>]*>/g, ""); }
  return cur.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
};
const safeHttpUrl = (u) => {
  if (typeof u !== "string") return null;
  try { const p = new URL(u.trim()); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; }
  catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q, width) {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({
    action: "query", format: "json", generator: "search", gsrsearch: `${q} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "15",
    prop: "imageinfo", iiprop: "url|extmetadata|size|mime", iiurlwidth: String(width),
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  const j = await r.json();
  return Object.values(j.query?.pages ?? {}).sort((a, b) => a.index - b.index);
}

for (const [key, spec] of Object.entries(queries)) {
  const dest = path.join(OUT, spec.dir, `${key}.jpg`);
  if (existsSync(dest) && credits[`${spec.dir}/${key}.jpg`]) continue;
  mkdirSync(path.dirname(dest), { recursive: true });
  let done = false;
  for (const q of spec.q) {
    const pages = await search(q, spec.width ?? 640);
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii || !/jpeg|png/.test(ii.mime)) continue;
      if (spec.skip && spec.skip.some((s) => p.title.toLowerCase().includes(s))) continue;
      if (ii.width < 500 || ii.height < 350) continue;
      const lic = ii.extmetadata?.LicenseShortName?.value ?? "";
      if (!/public domain|cc0|cc by/i.test(lic)) continue;
      const res = await fetch(ii.thumburl, { headers: { "User-Agent": UA } });
      if (!res.ok) { await sleep(1500); continue; }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      credits[`${spec.dir}/${key}.jpg`] = {
        title: p.title, source: safeHttpUrl(ii.descriptionurl) ?? "https://commons.wikimedia.org", author: strip(ii.extmetadata?.Artist?.value) || "Unknown", license: lic,
        licenseUrl: safeHttpUrl(ii.extmetadata?.LicenseUrl?.value),
      };
      console.log(`✔ ${key} ← ${p.title} (${lic})`);
      done = true;
      break;
    }
    if (done) break;
    await sleep(300);
  }
  if (!done) console.log(`✘ ${key} – no suitable image`);
  writeFileSync(creditsPath, JSON.stringify(credits, null, 2));
  await sleep(400);
}
