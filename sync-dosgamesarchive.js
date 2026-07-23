// Sync dosgamesarchive.com (~1,650 games) into the catalogue.
// Same union rules as sync-archiveorg: unique match -> link, ambiguous -> review,
// no match -> new catalogue game (origin 'dosgamesarchive').
// Crawls the listing (~104 pages), then one game page per new title at ~1 req/s;
// resumable — already-handled slugs are skipped, so interrupting is safe.
// Usage: node sync-dosgamesarchive.js [--limit N]
const cheerio = require('cheerio');
const { db } = require('./db');
const { buildIndex, matchTitle } = require('./matching');
const { SITE, fetchPage, parseFiles } = require('./sources/dosgamesarchive');

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listSlugs() {
  const slugs = new Map(); // slug -> listing title (longest variant)
  let maxPage = 1;
  for (let page = 1; page <= maxPage; page++) {
    const html = await fetchPage(`${SITE}/games?page=${page}`);
    const $ = cheerio.load(html);
    $('.pagination a[href*="page="]').each((_, a) => {
      const n = +($(a).attr('href').match(/page=(\d+)/) || [])[1];
      if (n > maxPage) maxPage = n;
    });
    $('a[href^="/download/"]').each((_, a) => {
      const slug = $(a).attr('href').replace('/download/', '').replace(/\/$/, '');
      const text = $(a).text().trim();
      if (!slug || !text) return;
      if (!slugs.has(slug) || text.length > slugs.get(slug).length) slugs.set(slug, text);
    });
    if (page % 20 === 0 || page === maxPage) console.log(`[dosgamesarchive] listing ${page}/${maxPage} pages, ${slugs.size} games`);
    await sleep(400);
  }
  return slugs;
}

async function main() {
  const index = buildIndex();
  const handled = db.prepare(`SELECT 1 FROM game_sources WHERE source = 'dosgamesarchive' AND source_slug = ?`);
  const inReview = db.prepare(`SELECT 1 FROM match_review WHERE source = 'dosgamesarchive' AND source_slug = ?`);
  const gameLinked = db.prepare(`SELECT 1 FROM game_sources WHERE source = 'dosgamesarchive' AND game_id = ?`);
  const insertLink = db.prepare(`
    INSERT INTO game_sources (game_id, source, source_slug, source_url, download_url, availability)
    VALUES (@game_id, 'dosgamesarchive', @slug, @url, @download_url, @availability)
  `);
  const insertReview = db.prepare(`
    INSERT INTO match_review (source, source_slug, title, year, candidates, source_url, download_url, thumb_url)
    VALUES ('dosgamesarchive', @slug, @title, @year, @candidates, @url, @url, @thumb)
  `);
  const insertGame = db.prepare(`
    INSERT INTO games (slug, url, title, year, thumb_url, origin, detail_scraped)
    VALUES (@slug, @url, @title, @year, @thumb, 'dosgamesarchive', 1)
  `);
  const stats = { linked: 0, added: 0, review: 0, already: 0, errors: 0 };
  let done = 0;

  const slugs = await listSlugs();
  for (const [slug, listTitle] of slugs) {
    if (handled.get(slug) || inReview.get(slug)) { stats.already++; continue; }
    if (done >= LIMIT) break;
    done++;
    const url = `${SITE}/download/${slug}`;
    try {
      const $ = cheerio.load(await fetchPage(url));
      const title = $('h1.game_page').first().text().trim() || listTitle;
      // the game's own year link reads exactly "1990"; sidebar year links read "1990 (12)"
      let year = null;
      $('a[href^="/year/"]').each((_, a) => {
        const m = $(a).attr('href').match(/\/year\/(\d{4})/);
        if (m && $(a).text().trim() === m[1] && !year) year = +m[1];
      });
      const files = parseFiles($);
      const availability = files.some((f) => !/demo/i.test(f.license || '')) ? 'free'
        : (files.length ? 'extras-only' : 'none');
      const thumb = ($('img[src*="/screenshots/"]').first().attr('src') || null);
      const common = { slug, url, download_url: files.length ? url : null, availability };

      const m = matchTitle(index, title, year);
      if (m.game && !gameLinked.get(m.game.id)) {
        insertLink.run({ game_id: m.game.id, ...common });
        stats.linked++;
      } else if (m.ambiguous) {
        insertReview.run({ slug, title, year, candidates: JSON.stringify(m.ambiguous.map((g) => g.id)), url, thumb });
        stats.review++;
      } else if (m.game) {
        stats.already++; // game already has a dosgamesarchive link from another slug
      } else {
        const g = insertGame.run({ slug: `dga-${slug}`, url, title, year, thumb });
        insertLink.run({ game_id: g.lastInsertRowid, ...common });
        stats.added++;
      }
    } catch (e) {
      console.log(`  error on ${slug}: ${e.message}`);
      stats.errors++;
    }
    if (done % 50 === 0) console.log(`[dosgamesarchive] ${done} game pages processed`, JSON.stringify(stats));
    await sleep(1000);
  }

  console.log(`[dosgamesarchive] done: ${stats.linked} linked, ${stats.added} added as new games, ` +
    `${stats.review} queued for review, ${stats.already} already handled, ${stats.errors} errors`);
}

main().catch((e) => { console.error(e); process.exit(1); });
