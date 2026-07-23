// Sync the Internet Archive MS-DOS collection into the catalogue.
//  - unique title+year match  -> link in game_sources
//  - ambiguous match          -> persisted in match_review for manual review
//  - no match                 -> added as a NEW catalogue game (origin 'archiveorg'):
//                                the app lists all available DOS games, not just
//                                the primary site's catalogue
// Idempotent — re-running skips everything already linked/added/reviewed.
// Usage: node sync-archiveorg.js [--dry-run]
const { db } = require('./db');
const { buildIndex, matchTitle } = require('./matching');

const COLLECTION = 'softwarelibrary_msdos_games';
const ROWS = 500;
const UA = 'dosvault/1.0 (personal catalogue; contact: local use)';
const DRY = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => Array.isArray(v) ? v.join(' ') : (v == null ? null : String(v));

async function* items() {
  let page = 1;
  let total = Infinity;
  let seen = 0;
  while (seen < total) {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`collection:${COLLECTION}`)}` +
      `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&fl[]=description&fl[]=creator` +
      `&rows=${ROWS}&page=${page}&output=json&sort[]=identifier asc`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`advancedsearch failed (HTTP ${r.status})`);
    const d = (await r.json()).response;
    total = d.numFound;
    for (const doc of d.docs) yield doc;
    seen += d.docs.length;
    if (!d.docs.length) break;
    console.log(`[archiveorg] fetched ${seen}/${total} items`);
    page++;
    await sleep(300);
  }
}

async function main() {
  const index = buildIndex();
  const itemLinked = db.prepare(`SELECT 1 FROM game_sources WHERE source = 'archiveorg' AND source_slug = ?`);
  const gameLinked = db.prepare(`SELECT 1 FROM game_sources WHERE source = 'archiveorg' AND game_id = ?`);
  const inReview = db.prepare(`SELECT 1 FROM match_review WHERE source = 'archiveorg' AND source_slug = ?`);
  const insertLink = db.prepare(`
    INSERT INTO game_sources (game_id, source, source_slug, source_url, download_url, availability)
    VALUES (?, 'archiveorg', ?, ?, ?, 'free')
  `);
  const insertReview = db.prepare(`
    INSERT INTO match_review (source, source_slug, title, year, candidates, source_url, download_url, thumb_url)
    VALUES ('archiveorg', @slug, @title, @year, @candidates,
      'https://archive.org/details/' || @slug, 'https://archive.org/download/' || @slug,
      'https://archive.org/services/img/' || @slug)
  `);
  const insertGame = db.prepare(`
    INSERT INTO games (slug, url, title, year, description, publisher, thumb_url, origin, detail_scraped)
    VALUES (@slug, @url, @title, @year, @description, @publisher, @thumb_url, 'archiveorg', 1)
  `);
  const stats = { linked: 0, added: 0, review: 0, already: 0 };

  const link = (gameId, id) => insertLink.run(gameId, id,
    `https://archive.org/details/${id}`, `https://archive.org/download/${id}`);

  for await (const item of items()) {
    const id = item.identifier;
    const title = str(item.title);
    if (!title) continue;
    if (itemLinked.get(id) || inReview.get(id)) { stats.already++; continue; }
    const year = parseInt(item.year, 10) || parseInt(String(item.date || '').slice(0, 4), 10) || null;
    const m = matchTitle(index, title, year);
    if (m.game) {
      if (gameLinked.get(m.game.id)) { stats.already++; continue; } // one IA item per game
      if (!DRY) link(m.game.id, id);
      stats.linked++;
    } else if (m.ambiguous) {
      if (!DRY) {
        insertReview.run({
          slug: id, title, year,
          candidates: JSON.stringify(m.ambiguous.map((g) => g.id)),
        });
      }
      stats.review++;
    } else {
      // not in the catalogue at all: add it as a new game contributed by this source
      if (!DRY) {
        const g = insertGame.run({
          slug: `ia-${id}`,
          url: `https://archive.org/details/${id}`,
          title,
          year,
          description: str(item.description),
          publisher: str(item.creator),
          thumb_url: `https://archive.org/services/img/${id}`,
        });
        link(g.lastInsertRowid, id);
      }
      stats.added++;
    }
  }

  console.log(`[archiveorg] done: ${stats.linked} linked, ${stats.added} added as new games, ` +
    `${stats.review} queued for review, ${stats.already} already handled${DRY ? ' [dry run]' : ''}`);
  const rescued = db.prepare(`
    SELECT count(*) c FROM games g
    WHERE NOT EXISTS (SELECT 1 FROM game_sources s WHERE s.game_id = g.id AND s.source = 'myabandonware' AND s.download_url IS NOT NULL)
      AND EXISTS (SELECT 1 FROM game_sources s WHERE s.game_id = g.id AND s.source = 'archiveorg')
  `).get().c;
  console.log(`[archiveorg] games downloadable only thanks to archive.org: ${rescued}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
