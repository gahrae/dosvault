// Resumable scraper for myabandonware.com DOS games.
// Phase 1: crawl list pages -> insert game stubs (slug, title, year, thumb_url).
// Phase 2: crawl each game detail page -> full metadata + download thumbnail.
// Usage: node sync-myabandonware.js [--lists-only|--details-only] [--limit N]
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { db, IMAGES_DIR } = require('./db');

const BASE = 'https://www.myabandonware.com';
const LIST_URL = (p) => p === 1 ? `${BASE}/browse/platform/dos/` : `${BASE}/browse/platform/dos/page/${p}/`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 1100;

const args = process.argv.slice(2);
const listsOnly = args.includes('--lists-only');
const detailsOnly = args.includes('--details-only');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url, asBuffer = false) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (attempt === 4) throw e;
      const wait = attempt * 5000;
      console.log(`  retry ${attempt} for ${url} after ${e.message}, waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

const getState = db.prepare('SELECT value FROM scrape_state WHERE key = ?');
const setState = db.prepare('INSERT INTO scrape_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

const insertStub = db.prepare(`
  INSERT INTO games (slug, url, title, year, thumb_url, screenshot_count)
  VALUES (@slug, @url, @title, @year, @thumb_url, @screenshot_count)
  ON CONFLICT(slug) DO UPDATE SET title = excluded.title, year = coalesce(excluded.year, games.year)
`);

function maxListPage(html) {
  // out-of-range pages still return content, so we must stop at the real last page
  const nums = [...html.matchAll(/\/browse\/platform\/dos\/page\/(\d+)\//g)].map((m) => +m[1]);
  return nums.length ? Math.max(...nums) : null;
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const games = [];
  $('.item.itemListGame').each((_, el) => {
    const $el = $(el);
    const a = $el.find('a.c-item-game__name');
    const href = a.attr('href');
    if (!href) return;
    const slug = href.replace(/^\/game\//, '').replace(/\/$/, '');
    const img = $el.find('img.c-thumb__img');
    const thumbs = (img.attr('data-thumbs') || '').split('@').filter(Boolean);
    games.push({
      slug,
      url: BASE + href,
      title: a.text().trim(),
      year: parseInt($el.find('.c-item-game__year').text(), 10) || null,
      thumb_url: img.attr('src') ? BASE + img.attr('src') : null,
      screenshot_count: thumbs.length || null,
    });
  });
  return games;
}

async function crawlLists() {
  let page = parseInt(getState.get('list_page')?.value || '1', 10);
  let lastPage = parseInt(getState.get('list_last_page')?.value || '0', 10) || null;
  console.log(`[lists] starting at page ${page}`);
  while (!lastPage || page <= lastPage) {
    const html = await fetchPage(LIST_URL(page));
    if (html === null) break;
    const mp = maxListPage(html);
    if (mp && mp !== lastPage) { lastPage = mp; setState.run('list_last_page', String(mp)); }
    const games = parseListPage(html);
    if (games.length === 0) { console.log(`[lists] page ${page} empty, done`); break; }
    const tx = db.transaction((gs) => gs.forEach((g) => insertStub.run(g)));
    tx(games);
    setState.run('list_page', String(page + 1));
    if (page % 10 === 0 || page === 1) {
      const total = db.prepare('SELECT count(*) c FROM games').get().c;
      console.log(`[lists] page ${page} done, ${total} games known`);
    }
    page++;
    await sleep(DELAY_MS);
  }
  setState.run('lists_done', '1');
  console.log(`[lists] complete: ${db.prepare('SELECT count(*) c FROM games').get().c} games`);
}

function textList($, cell) {
  // multi-value cells contain multiple <a>; fall back to comma-split text
  const links = $(cell).find('a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
  if (links.length) return links;
  return $(cell).text().split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeCountries(list) {
  // raw cell text can concatenate entries like "United States (1990)Germany";
  // strip the (year) parts and keep unique country names only
  const out = [];
  for (const raw of list) {
    for (const part of raw.split(/\s*\(\d{4}\)\s*/)) {
      const c = part.trim();
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

function parseGamePage(html) {
  const $ = cheerio.load(html);
  const out = { released_in: null, genres: null, themes: null, perspectives: null,
    alt_names: null, publisher: null, developer: null, dosbox: null, year: null };

  $('table.gameInfo tr').each((_, tr) => {
    const label = $(tr).find('th').text().trim().toLowerCase();
    const td = $(tr).find('td');
    if (!label) return;
    if (label === 'alt names' || label === 'alt name') out.alt_names = td.text().trim().replace(/\s*\n\s*/g, ', ');
    else if (label === 'year') out.year = parseInt(td.text(), 10) || null;
    else if (label === 'released in') out.released_in = JSON.stringify(normalizeCountries(textList($, td)));
    else if (label === 'genre') out.genres = JSON.stringify(textList($, td));
    else if (label === 'theme') out.themes = JSON.stringify(textList($, td));
    else if (label === 'perspective' || label === 'perspectives') out.perspectives = JSON.stringify(textList($, td));
    else if (label === 'publisher') out.publisher = textList($, td).join(', ') || null;
    else if (label === 'developer') out.developer = textList($, td).join(', ') || null;
    else if (label === 'dosbox support') out.dosbox = td.text().trim().replace(/\s+/g, ' ') || null;
  });

  // drop the site's "Read Full Description" expander link, which .text() would inline
  const desc = $('.gameDescription');
  desc.find('a, button, [class*="toggle"]').filter((_, e) => /read full description/i.test($(e).text())).remove();
  out.description = desc.length
    ? desc.text().trim().replace(/^Read Full Description\s*/i, '') || null
    : null;

  // community rating from JSON-LD VideoGame block
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const d = JSON.parse($(s).contents().text());
      if (d['@type'] === 'VideoGame' && d.aggregateRating) {
        out.community_rating = parseFloat(d.aggregateRating.ratingValue) || null;
        out.community_votes = parseInt(d.aggregateRating.ratingCount, 10) || null;
      }
    } catch {}
  });

  const dl = $('a[href^="/download/"]').first().attr('href');
  out.download_url = dl ? BASE + dl : null;
  return out;
}

const updateDetail = db.prepare(`
  UPDATE games SET alt_names=@alt_names, year=coalesce(@year, year), released_in=@released_in,
    genres=@genres, themes=@themes, perspectives=@perspectives, publisher=@publisher,
    developer=@developer, dosbox=@dosbox, description=@description,
    community_rating=@community_rating, community_votes=@community_votes,
    download_url=@download_url, thumb=@thumb, detail_scraped=1, scrape_error=NULL
  WHERE id=@id
`);
const markError = db.prepare('UPDATE games SET detail_scraped=2, scrape_error=? WHERE id=?');
// keep the per-source availability table in sync with re-scrapes (db.js seeds it at boot)
const upsertSource = db.prepare(`
  INSERT INTO game_sources (game_id, source, source_slug, source_url, download_url, availability)
  VALUES (@id, 'myabandonware', @slug, @url, @download_url,
    CASE WHEN @download_url IS NULL THEN 'none' ELSE 'unknown' END)
  ON CONFLICT(source, source_slug) DO UPDATE SET
    source_url = excluded.source_url, download_url = excluded.download_url
`);

async function downloadThumb(game) {
  if (!game.thumb_url) return null;
  const ext = path.extname(new URL(game.thumb_url).pathname) || '.png';
  const file = `${game.slug}${ext}`;
  const dest = path.join(IMAGES_DIR, file);
  if (fs.existsSync(dest)) return file;
  try {
    const buf = await fetchPage(game.thumb_url, true);
    if (!buf) return null;
    fs.writeFileSync(dest, buf);
    return file;
  } catch (e) {
    console.log(`  thumb failed for ${game.slug}: ${e.message}`);
    return null;
  }
}

async function crawlDetails() {
  const pending = db.prepare(`SELECT id, slug, url, thumb_url FROM games WHERE detail_scraped = 0 AND origin = 'myabandonware' ORDER BY id`).all();
  console.log(`[details] ${pending.length} games pending`);
  let done = 0;
  for (const game of pending) {
    if (done >= LIMIT) break;
    try {
      const html = await fetchPage(game.url);
      if (html === null) { markError.run('404', game.id); done++; continue; }
      const detail = parseGamePage(html);
      detail.thumb = await downloadThumb(game);
      detail.id = game.id;
      detail.community_rating = detail.community_rating ?? null;
      detail.community_votes = detail.community_votes ?? null;
      updateDetail.run(detail);
      upsertSource.run({ id: game.id, slug: game.slug, url: game.url, download_url: detail.download_url });
    } catch (e) {
      console.log(`  error on ${game.slug}: ${e.message}`);
      markError.run(e.message, game.id);
    }
    done++;
    if (done % 50 === 0) {
      const left = db.prepare('SELECT count(*) c FROM games WHERE detail_scraped = 0').get().c;
      console.log(`[details] ${done} this run, ${left} remaining`);
    }
    await sleep(DELAY_MS);
  }
  const left = db.prepare('SELECT count(*) c FROM games WHERE detail_scraped = 0').get().c;
  console.log(`[details] run finished, ${left} remaining`);
}

(async () => {
  if (!detailsOnly && getState.get('lists_done')?.value !== '1') await crawlLists();
  if (!listsOnly) await crawlDetails();
  console.log('scraper done');
})();
