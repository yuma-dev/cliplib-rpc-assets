// Builds the asset pack from build/recipes/*.json: finds each image on a wiki, Steam or a direct url,
// crops it square, writes <game>/<key>.webp plus index.json, credits.json and preview.html.
//
//   node build/build.mjs                  build every recipe (cached downloads are reused)
//   node build/build.mjs repo peak        only these games
//   node build/build.mjs discover <wiki> <Category:Name | search terms>
//   node build/build.mjs check repo       build into build/.check/ only, index and credits untouched
//
// FFMPEG points at an ffmpeg with libwebp, else `ffmpeg` from PATH.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECIPES = join(ROOT, "build", "recipes");
const CACHE = join(ROOT, "build", ".cache");
const UA = "ClipLib-asset-builder/1.0 (+https://cliplib.app; rich presence art)";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const SIZE = 512;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wikis rate limit bursts (wiki.gg answers 429 after a few dozen quick calls)
let lastCall = 0;
async function polite() {
  const wait = lastCall + 400 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function getJson(url, referer) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await polite();
    const res = await fetch(url, { headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up on ${url}`);
}

// Fandom's image CDN answers a bare request with a Cloudflare challenge; any Referer gets the file
async function download(url, referer) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, createHash("sha1").update(url).digest("hex"));
  if (existsSync(file)) return file;
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer || new URL(url).origin + "/" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const api = (wiki) => `${wiki.replace(/\/$/, "")}/api.php`;

async function fileUrl(wiki, file) {
  const name = file.startsWith("File:") ? file : `File:${file}`;
  const d = await getJson(`${api(wiki)}?action=query&titles=${encodeURIComponent(name)}&prop=imageinfo&iiprop=url|size&format=json`);
  const page = Object.values(d.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) throw new Error(`no file ${name} on ${wiki}`);
  return { url: info.url, width: info.width, height: info.height, page: page.title };
}

// skip logos, icons and tiny UI art when guessing a page's picture
const NOT_ART = /(icon|logo|symbol|button|arrow|_ui|\.svg$|\.gif$|favicon|placeholder|sprite|portrait_frame)/i;

/** The page's lead image: PageImages where the wiki has it (Fandom), else the biggest picture on the page. */
async function pageImage(wiki, title) {
  const pi = await getJson(
    `${api(wiki)}?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&piprop=original&redirects=1&format=json`,
  ).catch(() => null);
  const p = Object.values(pi?.query?.pages ?? {})[0];
  if (p?.original?.source) return { url: p.original.source, page: p.title };

  const parsed = await getJson(`${api(wiki)}?action=parse&page=${encodeURIComponent(title)}&prop=images&redirects=1&format=json`);
  const images = (parsed.parse?.images ?? []).filter((f) => !NOT_ART.test(f)).slice(0, 8);
  let best = null;
  for (const f of images) {
    const info = await fileUrl(wiki, f).catch(() => null);
    if (!info || info.width < 200) continue;
    const score = info.width * info.height;
    if (!best || score > best.score) best = { ...info, score };
  }
  if (!best) throw new Error(`no picture on ${title}`);
  return { url: best.url, page: parsed.parse?.title ?? title };
}

const steamCache = new Map();
async function steamImage(appid, which) {
  if (which === "header" || which === "hero" || which === "capsule") {
    const file = { header: "header.jpg", hero: "library_hero.jpg", capsule: "library_600x900.jpg" }[which];
    return { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${file}`, page: `https://store.steampowered.com/app/${appid}` };
  }
  const n = Number(which.replace(/^ss:/, ""));
  if (!steamCache.has(appid)) {
    const d = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=screenshots`);
    steamCache.set(appid, d[appid]?.data?.screenshots ?? []);
  }
  const ss = steamCache.get(appid)[n];
  if (!ss) throw new Error(`steam ${appid} has no screenshot ${n}`);
  return { url: ss.path_full, page: `https://store.steampowered.com/app/${appid}` };
}

async function resolve(recipe, item) {
  if (item.url) return { url: item.url, page: item.source ?? item.url };
  if (item.steam) return steamImage(item.steam_appid ?? recipe.steam_appid, item.steam);
  const wiki = item.wiki ?? recipe.wiki;
  if (item.file) {
    const f = await fileUrl(wiki, item.file);
    return { url: f.url, page: `${wiki}/wiki/${encodeURIComponent(f.page.replace(/ /g, "_"))}` };
  }
  if (item.page) {
    const p = await pageImage(wiki, item.page);
    return { url: p.url, page: `${wiki}/wiki/${encodeURIComponent(p.page.replace(/ /g, "_"))}` };
  }
  throw new Error(`${recipe.game}/${item.key}: needs page, file, steam or url`);
}

/** `trim` cuts frames, captions and vignettes off first ({ top, right, bottom, left } as fractions),
 * then a square crop around `focus` (0 left .. 1 right, 0.5 default; `focus_y` likewise), 512 px WebP.
 * `banner: true` crops 3:1 to 1536x512 instead (settings page tiles), `fit: "contain"` pads a logo
 * onto a transparent square so Discord's square crop can't cut it. */
function convert(src, out, item, trim = {}) {
  const fx = item.focus ?? 0.5;
  const fy = item.focus_y ?? 0.5;
  const t = { top: 0, right: 0, bottom: 0, left: 0, ...trim, ...(item.trim ?? {}) };
  const pre =
    t.top || t.right || t.bottom || t.left
      ? `crop=iw*${1 - t.left - t.right}:ih*${1 - t.top - t.bottom}:iw*${t.left}:ih*${t.top},`
      : "";
  const fit = item.banner
    ? `crop='min(iw,ih*3)':'min(iw,ih*3)/3':'(iw-min(iw,ih*3))*${fx}':'(ih-min(iw,ih*3)/3)*${fy}',` +
      `scale=${SIZE * 3}:${SIZE}:flags=lanczos`
    : item.fit === "contain"
      ? `format=rgba,pad='trunc(max(iw,ih)*1.12)':'trunc(max(iw,ih)*1.12)':'(ow-iw)/2':'(oh-ih)/2':color=black@0,` +
        `scale=${SIZE}:${SIZE}:flags=lanczos`
      : `crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))*${fx}':'(ih-min(iw,ih))*${fy}',` +
        `scale=${SIZE}:${SIZE}:flags=lanczos`;
  const vf = pre + fit;
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(FFMPEG, ["-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", vf, "-c:v", "libwebp", "-quality", "82", out]);
}

async function discover(wiki, what) {
  let titles;
  if (what.startsWith("Category:")) {
    const d = await getJson(`${api(wiki)}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(what)}&cmlimit=200&cmtype=page&format=json`);
    titles = d.query.categorymembers.map((m) => m.title);
  } else {
    const d = await getJson(`${api(wiki)}?action=query&list=search&srsearch=${encodeURIComponent(what)}&srlimit=20&format=json`);
    titles = d.query.search.map((m) => m.title);
  }
  for (const t of titles) {
    const img = await pageImage(wiki, t).catch((e) => ({ url: `(${e.message})` }));
    console.log(`${t}\t${img.url}`);
  }
}

async function build(only, dry = false) {
  const recipes = readdirSync(RECIPES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RECIPES, f), "utf8")))
    .filter((r) => only.length === 0 || only.includes(r.game));

  const indexPath = join(ROOT, "index.json");
  const creditsPath = join(ROOT, "credits.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { games: {} };
  const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, "utf8")) : {};
  let failures = 0;

  const out = dry ? join(ROOT, "build", ".check") : ROOT;
  for (const r of recipes) {
    const dir = join(out, r.game);
    rmSync(dir, { recursive: true, force: true });
    const items = {};
    for (const item of r.items) {
      const file = `${r.game}/${item.key}.webp`;
      try {
        const src = await resolve(r, item);
        const raw = await download(src.url, src.page);
        convert(raw, join(out, file), item, (item.page || item.file) && !item.steam ? r.wiki_trim : undefined);
        items[item.key] = { label: item.label, file, aliases: item.aliases ?? [] };
        credits[file] = { source: src.page, image: src.url, game: r.name };
        console.log(`ok   ${file}`);
      } catch (e) {
        failures++;
        delete credits[file];
        console.log(`FAIL ${file}: ${e.message}`);
      }
    }
    index.games[r.game] = {
      name: r.name,
      steam_appid: r.steam_appid ?? null,
      discord_ids: r.discord_ids ?? [],
      items,
    };
  }

  if (dry) {
    console.log(failures ? `
${failures} failed` : `
all good, see build/.check/`);
    if (failures) process.exitCode = 1;
    return;
  }
  index.generated = new Date().toISOString().slice(0, 10);
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  writeFileSync(creditsPath, JSON.stringify(Object.fromEntries(Object.entries(credits).sort()), null, 2) + "\n");
  writePreview(index);
  console.log(failures ? `\n${failures} failed` : "\nall good");
  if (failures) process.exitCode = 1;
}

function writePreview(index) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sections = Object.entries(index.games)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, g]) => {
      const cards = Object.entries(g.items)
        .map(
          ([key, it]) =>
            `<figure><img src="${esc(it.file)}" loading="lazy"><figcaption><b>${esc(it.label)}</b><br>${esc(key)}` +
            (it.aliases.length ? `<br><i>${esc(it.aliases.join(", "))}</i>` : "") +
            `</figcaption></figure>`,
        )
        .join("");
      return `<h2>${esc(g.name)} <small>${esc(id)}</small></h2><div class="grid">${cards}</div>`;
    })
    .join("");
  writeFileSync(
    join(ROOT, "preview.html"),
    `<!doctype html><meta charset="utf-8"><title>ClipLib presence art</title><style>
body{background:#111214;color:#dbdee1;font:13px system-ui;margin:24px}
h2{margin:28px 0 10px;font-size:16px}small{color:#777;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
figure{margin:0;background:#1e1f22;border-radius:8px;padding:8px}
img{width:100%;aspect-ratio:1;border-radius:6px;display:block;object-fit:cover}
figcaption{margin-top:6px;line-height:1.35}i{color:#949ba4;font-size:11px}
</style>${sections}`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "discover") await discover(rest[0], rest.slice(1).join(" "));
else if (cmd === "check") await build(rest, true);
else await build([cmd, ...rest].filter(Boolean));
