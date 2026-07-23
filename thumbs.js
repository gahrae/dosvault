// One-shot thumbnail downloader: fetches thumb_url for every game that has no
// local image yet. Runs safely alongside sync-myabandonware.js (which skips existing files).
const fs = require('fs');
const path = require('path');
const { db, IMAGES_DIR } = require('./db');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const setThumb = db.prepare('UPDATE games SET thumb = ? WHERE id = ?');

async function download(game) {
  const ext = path.extname(new URL(game.thumb_url).pathname) || '.png';
  const file = `${game.slug}${ext}`;
  const dest = path.join(IMAGES_DIR, file);
  if (fs.existsSync(dest)) { setThumb.run(file, game.id); return 'exists'; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(game.thumb_url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return 'missing';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      setThumb.run(file, game.id);
      return 'ok';
    } catch (e) {
      if (attempt === 3) { console.log(`  failed ${game.slug}: ${e.message}`); return 'error'; }
      await sleep(attempt * 3000);
    }
  }
}

(async () => {
  const pending = db.prepare('SELECT id, slug, thumb_url FROM games WHERE thumb IS NULL AND thumb_url IS NOT NULL ORDER BY id').all();
  console.log(`[thumbs] ${pending.length} images to fetch`);
  let done = 0, ok = 0, failed = 0;
  for (const g of pending) {
    const r = await download(g);
    if (r === 'ok' || r === 'exists') ok++; else failed++;
    done++;
    if (done % 200 === 0) console.log(`[thumbs] ${done}/${pending.length} (${failed} failed)`);
    await sleep(DELAY_MS);
  }
  console.log(`[thumbs] done: ${ok} ok, ${failed} failed of ${pending.length}`);
})();
