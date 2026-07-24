const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const Database = require('better-sqlite3');
const { db, DATA_DIR, IMAGES_DIR } = require('./db');
const { config, fill } = require('./config');

const GAMES_DIR = config.gamesDir;

// source adapters; see sources/myabandonware.js for the contract.
// order = install preference when several sources can serve a game
const SOURCES = {
  myabandonware: require('./sources/myabandonware'),
  archiveorg: require('./sources/archiveorg'),
  dosgamesarchive: require('./sources/dosgamesarchive'),
};
const SOURCE_PRIORITY = Object.keys(SOURCES);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMAGES_DIR, { maxAge: '30d', immutable: true }));

const PAGE_SIZE = 60;

function ftsQuery(q) {
  // build a safe prefix-match FTS query from user input
  const terms = q.replace(/["'*]/g, ' ').split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

function buildFilters(query, params) {
  const where = [];
  if (query.q) {
    const fq = ftsQuery(query.q);
    if (fq) {
      where.push('g.id IN (SELECT rowid FROM games_fts WHERE games_fts MATCH @fts)');
      params.fts = fq;
    }
  }
  // repeatable filters: ?genre=a&genre=b matches games sharing at least one listed value
  for (const [field, col] of [['genre', 'genres'], ['theme', 'themes'], ['perspective', 'perspectives']]) {
    const vals = [].concat(query[field] || []).filter(Boolean);
    if (vals.length) {
      const names = vals.map((v, i) => { params[field + i] = v; return '@' + field + i; });
      where.push(`EXISTS (SELECT 1 FROM json_each(g.${col}) WHERE json_each.value IN (${names.join(', ')}))`);
    }
  }
  // repeatable too: ?tag=wife&tag=kids matches games carrying at least one of them
  const tagVals = [].concat(query.tag || []).filter(Boolean);
  if (tagVals.length) {
    const names = tagVals.map((v, i) => { params['tag' + i] = v; return '@tag' + i; });
    where.push(`EXISTS (SELECT 1 FROM game_tags gt JOIN tags t ON t.id = gt.tag_id
      WHERE gt.game_id = g.id AND t.name IN (${names.join(', ')}))`);
  }
  if (query.releasedIn) {
    where.push(`EXISTS (SELECT 1 FROM json_each(g.released_in) WHERE json_each.value = @releasedIn)`);
    params.releasedIn = query.releasedIn;
  }
  if (query.source) {
    where.push('EXISTS (SELECT 1 FROM game_sources fs WHERE fs.game_id = g.id AND fs.source = @source)');
    params.source = query.source;
  }
  if (query.yearMin) { where.push('g.year >= @yearMin'); params.yearMin = +query.yearMin; }
  if (query.yearMax) { where.push('g.year <= @yearMax'); params.yearMax = +query.yearMax; }
  if (query.minRating) { where.push('g.community_rating >= @minRating'); params.minRating = +query.minRating; }
  if (query.minVotes) { where.push('g.community_votes >= @minVotes'); params.minVotes = +query.minVotes; }
  if (query.myRating) { where.push('u.rating >= @myRating'); params.myRating = +query.myRating; }
  if (query.status) { where.push(`coalesce(u.status, 'none') = @status`); params.status = query.status; }
  if (query.shortlisted === '1') where.push('u.shortlisted = 1');
  if (query.rated === '1') where.push('u.rating IS NOT NULL');
  if (query.hasNotes === '1') where.push(`u.notes IS NOT NULL AND u.notes != ''`);
  if (query.installed === '1') {
    pruneStaleInstalls();
    where.push('u.install_path IS NOT NULL');
  }
  // hide "not interested" unless explicitly asked for or included
  if (query.status !== 'not_interested' && query.includeHidden !== '1') {
    where.push(`coalesce(u.status, 'none') != 'not_interested'`);
  }
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

const SORTS = {
  title: 'g.title COLLATE NOCASE ASC',
  year: 'g.year ASC NULLS LAST, g.title COLLATE NOCASE ASC',
  year_desc: 'g.year DESC NULLS LAST, g.title COLLATE NOCASE ASC',
  rating: 'g.community_rating DESC NULLS LAST, g.community_votes DESC',
  votes: 'g.community_votes DESC NULLS LAST',
  my_rating: 'u.rating DESC NULLS LAST, g.title COLLATE NOCASE ASC',
  shortlist: 'u.shortlist_order ASC NULLS LAST, u.updated_at DESC',
};

const GAME_COLS = `g.id, g.slug, s.source_url AS url, g.title, g.alt_names, g.year, g.released_in, g.genres,
  g.themes, g.perspectives, g.publisher, g.developer, g.dosbox, g.description,
  g.community_rating, g.community_votes, g.thumb, g.thumb_url, g.screenshot_count, s.download_url,
  u.rating AS my_rating, u.notes, coalesce(u.status,'none') AS status,
  coalesce(u.shortlisted,0) AS shortlisted, u.shortlist_order, u.install_path, u.run_exe, u.run_custom,
  (SELECT json_group_array(json_object(
     'source', gs.source, 'url', gs.source_url, 'availability', gs.availability,
     'hasDownload', gs.download_url IS NOT NULL))
   FROM game_sources gs WHERE gs.game_id = g.id) AS sources,
  (SELECT json_group_array(name) FROM (
     SELECT t.name FROM game_tags gt JOIN tags t ON t.id = gt.tag_id
     WHERE gt.game_id = g.id ORDER BY t.name COLLATE NOCASE)) AS tags`;

// user_data plus the (currently single) source row for each game
const FROM_GAMES = `FROM games g
  LEFT JOIN user_data u ON u.game_id = g.id
  LEFT JOIN game_sources s ON s.game_id = g.id AND s.source = 'myabandonware'`;

app.get('/api/games', (req, res) => {
  const params = {};
  const whereSql = buildFilters(req.query, params);
  const sort = SORTS[req.query.sort] || SORTS.title;
  const page = Math.max(1, +req.query.page || 1);
  const base = `${FROM_GAMES} ${whereSql}`;
  const total = db.prepare(`SELECT count(*) c ${base}`).get(params).c;
  const rows = db.prepare(`SELECT ${GAME_COLS} ${base} ORDER BY ${sort} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`).all(params);
  res.json({ total, page, pageSize: PAGE_SIZE, games: rows });
});

app.get('/api/games/random', (req, res) => {
  const params = {};
  const whereSql = buildFilters(req.query, params);
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} ${whereSql} ORDER BY random() LIMIT 1`).get(params);
  if (!row) return res.status(404).json({ error: 'no games match' });
  res.json(row);
});

app.get('/api/games/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(attachInstall(row));
});

// ---------- install & run ----------

const clearInstall = db.prepare('UPDATE user_data SET install_path = NULL, run_exe = NULL WHERE game_id = ?');

// the user can delete a game folder from ~/dosgames directly; forget stale installs
function pruneStaleInstalls() {
  const rows = db.prepare('SELECT game_id, install_path FROM user_data WHERE install_path IS NOT NULL').all();
  for (const r of rows) {
    if (!fs.existsSync(r.install_path)) clearInstall.run(r.game_id);
  }
}

function attachInstall(row) {
  row.installed = !!(row.install_path && fs.existsSync(row.install_path));
  if (row.install_path && !row.installed) {
    clearInstall.run(row.id);
    row.install_path = null;
    row.run_exe = null;
  }
  row.executables = row.installed ? listAllExecutables(row.install_path) : [];
  row.cd_images = row.installed ? findCdImages(row.install_path) : [];
  row.manual = row.installed ? findManual(row.install_path) : null;
  return row;
}

// site manuals are named *_Manual_*; also accept any PDF in the install folder
function findManual(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/manual/i.test(e.name) || /\.pdf$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  if (!out.length) return null;
  const score = (p) => (/manual/i.test(path.basename(p)) ? 0 : 10) + (/\.pdf$/i.test(p) ? 0 : 1);
  return out.sort((a, b) => score(a) - score(b))[0];
}

// best launch candidate first: go/start/run/play scripts, then exe > bat > com,
// with install/setup/config helpers last
const scoreExe = (p) => {
  const base = path.basename(p).replace(/\.[^.]+$/, '').toLowerCase();
  if (/^(install|setup|config|setsound|sound|readme)/.test(base)) return 90;
  if (/^(go|start|run|play|fun)$/.test(base)) return 0;
  return { '.exe': 10, '.bat': 20, '.com': 30 }[path.extname(p).toLowerCase()] ?? 50;
};
const sortExes = (arr) => arr.sort((a, b) => scoreExe(a) - scoreExe(b)
  || a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b));

function listExecutables(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/\.(bat|exe|com)$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  return sortExes(out);
}

// CD images in the install folder, for DOSBox IMGMOUNT. A .cue mounts its own
// data file, so same-stem .bin/.iso/.img siblings are dropped in its favour;
// .iso/.bin/.img without a cue must carry the ISO9660 magic (many games ship
// plain data files named *.bin). .img covers CloneCD rips (.ccd/.img/.sub) —
// the .img is raw 2352-byte sectors, which DOSBox mounts directly as iso.
function findCdImages(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/\.(iso|cue|bin|img)$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  const stem = (p) => p.replace(/\.[^.]+$/, '').toLowerCase();
  const cueStems = new Set(out.filter((p) => /\.cue$/i.test(p)).map(stem));
  return out
    .filter((p) => /\.cue$/i.test(p)
      || (!cueStems.has(stem(p)) && isCdImage(path.join(dir, p))))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// file paths inside an ISO, via config.isoList (cached — attachInstall runs on every fetch)
const isoListCache = new Map();
function listIsoFiles(isoAbs) {
  const st = fs.statSync(isoAbs);
  const hit = isoListCache.get(isoAbs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries;
  let entries = [];
  try {
    const [cmd, ...args] = fill(config.isoList, { archive: isoAbs });
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    entries = [...new Set(stdout.split('\n')
      .map((l) => l.trim().replace(/;1$/, '').replace(/\\/g, '/').replace(/^\.?\//, ''))
      .filter(Boolean))];
  } catch (e) {
    console.error(`isoList failed for ${isoAbs}: ${e.message}`);
  }
  isoListCache.set(isoAbs, { mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}

// disk executables first (a game installed from CD to D: should outrank the CD
// copy), then "cd:"-prefixed ones found inside plain ISO images
function listAllExecutables(dir) {
  const cd = new Set();
  for (const img of findCdImages(dir)) {
    if (!/\.iso$/i.test(img)) continue; // cue/bin/img sectors aren't listable, still mountable
    for (const f of listIsoFiles(path.join(dir, img))) {
      if (/\.(bat|exe|com)$/i.test(f)) cd.add('cd:' + f);
    }
  }
  return [...listExecutables(dir), ...sortExes([...cd].map((e) => e.slice(3))).map((e) => 'cd:' + e)];
}

const setInstallPath = db.prepare(`
  INSERT INTO user_data (game_id, install_path, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(game_id) DO UPDATE SET install_path = excluded.install_path, updated_at = datetime('now')
`);

async function downloadFile(fileUrl, destDir, headers, onProgress) {
  const dest = path.join(destDir, decodeURIComponent(path.basename(new URL(fileUrl).pathname)));
  const r = await fetch(fileUrl, { headers });
  if (!r.ok) throw new Error(`file download failed (HTTP ${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  let got = 0;
  const src = Readable.fromWeb(r.body);
  if (onProgress) src.on('data', (c) => { got += c.length; onProgress(got, total); });
  await pipeline(src, fs.createWriteStream(dest));
  if (onProgress && total) onProgress(total, total);
  return dest;
}

// trust magic bytes, not extensions — archive.org ".play" bundles are zips
function isZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    fs.closeSync(fd);
  }
}

// ISO9660: "CD001" in the primary volume descriptor at sector 16 — checked at
// both the 2048-byte (.iso) and raw 2352-byte (.bin/.img, 16-byte sector
// header) sector offsets. Guards against e.g. game data files named *.bin.
function isCdImage(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(5);
    for (const off of [16 * 2048 + 1, 16 * 2352 + 16 + 1]) {
      if (fs.readSync(fd, b, 0, 5, off) === 5 && b.toString('latin1') === 'CD001') return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

async function extract(archivePath, destDir) {
  const [cmd, ...args] = fill(config.unzip, { archive: archivePath, dest: destDir });
  await execFileP(cmd, args);
}

// extract; if the archive has a single top-level directory, that's the game's folder
async function unzipTopDir(archivePath, destDir) {
  await extract(archivePath, destDir);
  const [cmd, ...args] = fill(config.unzipList, { archive: archivePath });
  const { stdout } = await execFileP(cmd, args);
  const tops = new Set(stdout.split('\n').filter(Boolean).map((l) => l.split('/')[0]));
  if (tops.size === 1) {
    const top = path.join(destDir, [...tops][0]);
    if (fs.existsSync(top) && fs.statSync(top).isDirectory()) return top;
  }
  return destDir;
}

app.post('/api/games/:id/install', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(+req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare(`
    SELECT * FROM game_sources WHERE game_id = ? AND download_url IS NOT NULL AND source IN (${
      SOURCE_PRIORITY.map(() => '?').join(', ')})
  `).all(game.id, ...SOURCE_PRIORITY);
  // sources known (from a previous install) to lack the game rank below ones that have it
  const lacksGame = (r) => r.availability === 'extras-only' || r.availability === 'none';
  rows.sort((a, b) => (lacksGame(a) - lacksGame(b)) ||
    (SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source)));
  const src = req.query.source ? rows.find((r) => r.source === req.query.source) : rows[0];
  if (!src) return res.status(400).json({ error: 'no download available for this game' });
  const adapter = SOURCES[src.source];
  // NDJSON progress stream: {type:'log'|'progress'|'done'|'error'} events, one per line
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  const log = (text) => send({ type: 'log', text });
  const progress = (file) => {
    let last = -1;
    return (done, total) => {
      const step = total ? Math.floor((done / total) * 50) : Math.floor(done / 524288);
      if (step === last) return;
      last = step;
      send({ type: 'progress', file, done, total });
    };
  };
  try {
    log(`SOURCE ${adapter.name}`);
    log(`CONNECT ${new URL(src.source_url).host}`);
    const info = await adapter.resolveDownloads(src, { log });
    db.prepare(`UPDATE game_sources SET availability = ?, last_checked = datetime('now')
      WHERE source = ? AND source_slug = ?`).run(info.availability, src.source, src.source_slug);

    log(`FOUND ${info.totalGameFiles} game file(s), ${info.manuals.length} manual(s)`);
    const destDir = path.join(GAMES_DIR, game.slug);
    fs.mkdirSync(destDir, { recursive: true });
    const warnings = [];
    let gameRoot = destDir;
    const best = info.gameFiles[0];
    if (best) {
      if (info.totalGameFiles > 1) log(`SELECT "${best.desc || best.href}" of ${info.totalGameFiles} downloads`);
      log('RESOLVE download token');
      const file = await best.resolve();
      const fname = decodeURIComponent(path.basename(new URL(file.url).pathname));
      const archivePath = await downloadFile(file.url, destDir, file.headers, progress(fname));
      if (isZip(archivePath)) {
        log(`UNZIP ${fname}`);
        gameRoot = await unzipTopDir(archivePath, destDir);
      } else if (isCdImage(archivePath)) {
        log(`ISO ${fname} is a CD image — DOSBox will mount it at run time`);
      } else {
        warnings.push(`Downloaded ${path.basename(archivePath)} — not a zip, extract it manually`);
      }
    } else {
      warnings.push(`${adapter.name} offers no game download for this title (it is likely sold commercially again) — only the extras below were installed.`);
    }
    for (const m of info.manuals) {
      try {
        log('RESOLVE manual token');
        const file = await m.resolve();
        const manualName = decodeURIComponent(path.basename(new URL(file.url).pathname));
        const manualPath = await downloadFile(file.url, gameRoot, file.headers, progress(manualName));
        if (isZip(manualPath)) {
          log(`UNZIP ${manualName}`);
          await extract(manualPath, gameRoot);
        }
      } catch (e) {
        warnings.push(`Manual: ${e.message}`);
      }
    }
    setInstallPath.run(game.id, destDir);
    const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(game.id);
    const full = attachInstall(row);
    if (full.cd_images.length) log(`CD ${full.cd_images.length} disc image(s) detected: ${full.cd_images.join(', ')}`);
    log(`SCAN ${full.executables.length} executable(s) found`);
    log(`OK installed to ${destDir}`);
    send({ type: 'done', game: { ...full, warning: warnings.join(' | ') || null } });
  } catch (e) {
    send({ type: 'error', error: e.message });
  }
  res.end();
});

app.post('/api/games/:id/open-folder', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const u = db.prepare('SELECT install_path FROM user_data WHERE game_id = ?').get(+req.params.id);
  if (!u || !u.install_path || !fs.existsSync(u.install_path)) {
    return res.status(400).json({ error: 'not installed' });
  }
  const [cmd, ...args] = fill(config.openFolder, { dir: u.install_path });
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});

app.get('/api/games/:id/manual', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const u = db.prepare('SELECT install_path FROM user_data WHERE game_id = ?').get(+req.params.id);
  if (!u || !u.install_path || !fs.existsSync(u.install_path)) {
    return res.status(404).json({ error: 'not installed' });
  }
  const m = findManual(u.install_path);
  if (!m) return res.status(404).json({ error: 'no manual found' });
  res.sendFile(path.resolve(u.install_path, m));
});

app.post('/api/games/:id/uninstall', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  const u = db.prepare('SELECT install_path FROM user_data WHERE game_id = ?').get(id);
  if (!u || !u.install_path) return res.status(400).json({ error: 'not installed' });
  // only ever delete inside the games dir, no matter what the db says
  const target = path.resolve(u.install_path);
  if (!target.startsWith(path.resolve(GAMES_DIR) + path.sep)) {
    return res.status(400).json({ error: `refusing to delete outside ${GAMES_DIR}` });
  }
  fs.rmSync(target, { recursive: true, force: true });
  clearInstall.run(id);
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(id);
  res.json(attachInstall(row));
});

function launchDosbox(cmds) {
  const [cmd, ...args] = [...config.dosbox, ...cmds.flatMap((c) => ['-c', c])];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

app.post('/api/games/:id/run', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  const u = db.prepare('SELECT install_path, run_exe, run_custom FROM user_data WHERE game_id = ?').get(id);
  if (!u || !u.install_path || !fs.existsSync(u.install_path)) {
    return res.status(400).json({ error: 'not installed' });
  }
  const images = findCdImages(u.install_path);
  // custom script: user-authored DOSBox commands, run after the usual D:/E:
  // mounts so the game dir and any CD images are available to them
  if (req.body.custom) {
    const script = String(u.run_custom || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!script.length) return res.status(400).json({ error: 'no custom run commands saved' });
    const cmds = [`mount d "${path.resolve(u.install_path)}"`];
    if (images.length) {
      cmds.push(`imgmount e ${images.map((i) => `"${path.resolve(u.install_path, i)}"`).join(' ')} -t iso`);
    }
    cmds.push(...script);
    launchDosbox(cmds);
    return res.json({ ok: true, custom: true });
  }
  const exes = listAllExecutables(u.install_path);
  // only exes we enumerated ourselves may run — this also blocks path traversal
  const saved = exes.includes(u.run_exe) ? u.run_exe : null;
  const exe = req.body.exe || saved || exes[0] || null;
  if (exe && !exes.includes(exe)) return res.status(400).json({ error: 'bad exe path' });
  if (!exe && !images.length) {
    return res.status(400).json({ error: `no .bat/.exe/.com found in ${u.install_path}` });
  }
  // D: = game dir (any autoexec C: mount is left alone), E: = CD images if present
  const cmds = [];
  if (images.length) {
    cmds.push(`mount d "${path.resolve(u.install_path)}"`);
    cmds.push(`imgmount e ${images.map((i) => `"${path.resolve(u.install_path, i)}"`).join(' ')} -t iso`);
    if (exe) {
      const onCd = exe.startsWith('cd:');
      const rel = onCd ? exe.slice(3) : exe;
      cmds.push(onCd ? 'e:' : 'd:');
      const dir = path.dirname(rel);
      if (dir !== '.') cmds.push(`cd ${dir.split(/[\\/]/).join('\\')}`);
      cmds.push(path.basename(rel));
    } else {
      cmds.push('e:'); // nothing runnable found — drop the user at the CD prompt
    }
  } else {
    const full = path.resolve(u.install_path, exe);
    cmds.push(`mount d "${path.dirname(full)}"`, 'd:', path.basename(full));
  }
  launchDosbox(cmds);
  if (exe) db.prepare('UPDATE user_data SET run_exe = ? WHERE game_id = ?').run(exe, id);
  res.json({ ok: true, exe });
});

// save the per-game custom DOSBox command script (empty clears it)
app.post('/api/games/:id/run-custom', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) return res.status(404).json({ error: 'no such game' });
  const raw = typeof req.body.commands === 'string' ? req.body.commands : '';
  const text = raw.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n+$/, '').slice(0, 2000) || null;
  db.prepare(`
    INSERT INTO user_data (game_id, run_custom, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(game_id) DO UPDATE SET run_custom = excluded.run_custom, updated_at = datetime('now')
  `).run(id, text);
  res.json({ ok: true, run_custom: text });
});

const upsertUser = db.prepare(`
  INSERT INTO user_data (game_id, rating, notes, status, shortlisted, shortlist_order, updated_at)
  VALUES (@game_id, @rating, @notes, @status, @shortlisted, @shortlist_order, datetime('now'))
  ON CONFLICT(game_id) DO UPDATE SET
    rating = @rating, notes = @notes, status = @status,
    shortlisted = @shortlisted, shortlist_order = @shortlist_order, updated_at = datetime('now')
`);

app.patch('/api/games/:id/user', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  const cur = db.prepare('SELECT * FROM user_data WHERE game_id = ?').get(id) ||
    { rating: null, notes: '', status: 'none', shortlisted: 0, shortlist_order: null };
  const b = req.body;
  const next = {
    game_id: id,
    rating: b.rating !== undefined ? (b.rating === null ? null : Math.min(5, Math.max(1, +b.rating))) : cur.rating,
    notes: b.notes !== undefined ? String(b.notes) : cur.notes,
    status: b.status !== undefined ? b.status : cur.status,
    shortlisted: b.shortlisted !== undefined ? (b.shortlisted ? 1 : 0) : cur.shortlisted,
    shortlist_order: cur.shortlist_order,
  };
  if (!['none', 'played', 'finished', 'abandoned', 'not_interested'].includes(next.status)) {
    return res.status(400).json({ error: 'bad status' });
  }
  if (next.shortlisted && !cur.shortlisted) {
    const max = db.prepare('SELECT max(shortlist_order) m FROM user_data WHERE shortlisted = 1').get().m;
    next.shortlist_order = (max || 0) + 1;
  }
  if (!next.shortlisted) next.shortlist_order = null;
  upsertUser.run(next);
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(id);
  res.json(attachInstall(row));
});

app.post('/api/shortlist/reorder', (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const stmt = db.prepare('UPDATE user_data SET shortlist_order = ? WHERE game_id = ? AND shortlisted = 1');
  db.transaction(() => ids.forEach((id, i) => stmt.run(i + 1, id)))();
  res.json({ ok: true });
});

// ---------- tags ----------

const normalizeTag = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);

// tags.name is COLLATE NOCASE, so "Kids" reuses an existing "kids"
function getOrCreateTag(name) {
  const hit = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
  return hit ? hit.id : db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid;
}

app.post('/api/games/:id/tags', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  const name = normalizeTag(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'tag name required' });
  db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(id, getOrCreateTag(name));
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(id);
  res.json(attachInstall(row));
});

app.delete('/api/games/:id/tags', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const id = +req.params.id;
  const name = normalizeTag(req.body && req.body.name);
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
  if (tag) {
    db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?').run(id, tag.id);
    // drop the tag itself once no game carries it, so the filter list stays clean
    db.prepare('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM game_tags WHERE tag_id = ?)')
      .run(tag.id, tag.id);
  }
  const row = db.prepare(`SELECT ${GAME_COLS} ${FROM_GAMES} WHERE g.id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(attachInstall(row));
});

// ---------- saved filter presets ----------

app.get('/api/presets', (req, res) => {
  const rows = db.prepare('SELECT name, filters FROM filter_presets ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map((r) => ({ name: r.name, filters: JSON.parse(r.filters) })));
});

// upsert: saving under an existing name (case-insensitively) overwrites it
app.post('/api/presets', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const filters = req.body && req.body.filters;
  if (!name) return res.status(400).json({ error: 'preset name required' });
  if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'filters object required' });
  db.prepare(`
    INSERT INTO filter_presets (name, filters, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET filters = excluded.filters, updated_at = datetime('now')
  `).run(name, JSON.stringify(filters));
  res.json({ ok: true, name });
});

app.delete('/api/presets', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const gone = db.prepare('DELETE FROM filter_presets WHERE name = ?').run(name).changes;
  if (!gone) return res.status(404).json({ error: 'preset not found' });
  res.json({ ok: true });
});

// ---------- user data export / import ----------

app.get('/api/export', (req, res) => {
  const rows = db.prepare(`
    SELECT g.slug, u.rating, u.notes, u.status, u.shortlisted, u.shortlist_order, u.run_exe, u.run_custom
    FROM user_data u JOIN games g ON g.id = u.game_id
    WHERE u.rating IS NOT NULL OR (u.notes IS NOT NULL AND u.notes != '')
       OR coalesce(u.status, 'none') != 'none' OR u.shortlisted = 1 OR u.run_exe IS NOT NULL
       OR u.run_custom IS NOT NULL
  `).all();
  // tags live in game_tags, not user_data — merge them in, adding rows for tag-only games
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const tagRows = db.prepare(`
    SELECT g.slug, t.name FROM game_tags gt
    JOIN tags t ON t.id = gt.tag_id JOIN games g ON g.id = gt.game_id
    ORDER BY t.name COLLATE NOCASE
  `).all();
  for (const { slug, name } of tagRows) {
    let r = bySlug.get(slug);
    if (!r) { r = { slug }; bySlug.set(slug, r); rows.push(r); }
    (r.tags = r.tags || []).push(name);
  }
  const presets = db.prepare('SELECT name, filters FROM filter_presets ORDER BY name COLLATE NOCASE').all()
    .map((r) => ({ name: r.name, filters: JSON.parse(r.filters) }));
  res.setHeader('Content-Disposition',
    `attachment; filename="dosvault-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: 'dosvault', version: 2, exported_at: new Date().toISOString(), games: rows, presets });
});

app.post('/api/import', (req, res) => {
  const list = req.body && Array.isArray(req.body.games) ? req.body.games : null;
  if (!list) return res.status(400).json({ error: 'not a valid export file (missing games array)' });
  const bySlug = db.prepare('SELECT id FROM games WHERE slug = ?');
  const up = db.prepare(`
    INSERT INTO user_data (game_id, rating, notes, status, shortlisted, shortlist_order, run_exe, run_custom, updated_at)
    VALUES (@game_id, @rating, @notes, @status, @shortlisted, @shortlist_order, @run_exe, @run_custom, datetime('now'))
    ON CONFLICT(game_id) DO UPDATE SET
      rating = @rating, notes = @notes, status = @status, shortlisted = @shortlisted,
      shortlist_order = @shortlist_order, run_exe = @run_exe, run_custom = @run_custom, updated_at = datetime('now')
  `);
  const delTags = db.prepare('DELETE FROM game_tags WHERE game_id = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');
  let imported = 0;
  let missing = 0;
  db.transaction(() => {
    for (const it of list) {
      const g = it && typeof it.slug === 'string' ? bySlug.get(it.slug) : null;
      if (!g) { missing++; continue; }
      if (Array.isArray(it.tags)) {
        delTags.run(g.id);
        for (const raw of it.tags) {
          const name = normalizeTag(raw);
          if (name) linkTag.run(g.id, getOrCreateTag(name));
        }
      }
      up.run({
        game_id: g.id,
        rating: it.rating != null ? Math.min(5, Math.max(1, +it.rating || 1)) : null,
        notes: String(it.notes ?? ''),
        status: ['none', 'played', 'finished', 'abandoned', 'not_interested'].includes(it.status) ? it.status : 'none',
        shortlisted: it.shortlisted ? 1 : 0,
        shortlist_order: it.shortlist_order != null ? +it.shortlist_order : null,
        run_exe: typeof it.run_exe === 'string' ? it.run_exe : null,
        run_custom: typeof it.run_custom === 'string' ? it.run_custom : null,
      });
      imported++;
    }
    db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM game_tags)');
    if (Array.isArray(req.body.presets)) {
      const upPreset = db.prepare(`
        INSERT INTO filter_presets (name, filters, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET filters = excluded.filters, updated_at = datetime('now')`);
      for (const p of req.body.presets) {
        const name = p && typeof p.name === 'string' ? p.name.trim().slice(0, 60) : '';
        if (name && p.filters && typeof p.filters === 'object') upPreset.run(name, JSON.stringify(p.filters));
      }
    }
  })();
  res.json({ imported, missing });
});

// ---------- ambiguous match review ----------

app.get('/api/review', (req, res) => {
  const rows = db.prepare('SELECT * FROM match_review WHERE resolved = 0 ORDER BY title').all();
  const gameById = db.prepare('SELECT id, title, year, thumb FROM games WHERE id = ?');
  res.json(rows.map((r) => ({
    ...r,
    candidates: (JSON.parse(r.candidates || '[]')).map((id) => gameById.get(id)).filter(Boolean),
  })));
});

app.post('/api/review/resolve', (req, res) => {
  const { source, sourceSlug, action, gameId } = req.body || {};
  const row = db.prepare('SELECT * FROM match_review WHERE source = ? AND source_slug = ? AND resolved = 0')
    .get(source, sourceSlug);
  if (!row) return res.status(404).json({ error: 'review item not found' });
  const link = (gid) => db.prepare(`
    INSERT INTO game_sources (game_id, source, source_slug, source_url, download_url, availability)
    VALUES (?, ?, ?, ?, ?, 'free')
  `).run(gid, source, row.source_slug, row.source_url, row.download_url);
  if (action === 'link') {
    if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(+gameId)) return res.status(400).json({ error: 'bad gameId' });
    link(+gameId);
  } else if (action === 'new') {
    const g = db.prepare(`
      INSERT INTO games (slug, url, title, year, thumb_url, origin, detail_scraped)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(`${source}-${row.source_slug}`, row.source_url, row.title, row.year, row.thumb_url, source);
    link(g.lastInsertRowid);
  } else if (action !== 'skip') {
    return res.status(400).json({ error: 'action must be link, new, or skip' });
  }
  db.prepare('UPDATE match_review SET resolved = 1 WHERE source = ? AND source_slug = ?').run(source, row.source_slug);
  res.json({ ok: true, remaining: db.prepare('SELECT count(*) c FROM match_review WHERE resolved = 0').get().c });
});

// reverse a resolve: unlink the source row, remove a game the resolve created
// (unless the user has since rated/annotated it), and reopen the review item
app.post('/api/review/undo', (req, res) => {
  const { source, sourceSlug } = req.body || {};
  const row = db.prepare('SELECT * FROM match_review WHERE source = ? AND source_slug = ? AND resolved = 1')
    .get(source, sourceSlug);
  if (!row) return res.status(404).json({ error: 'nothing to undo' });
  const gs = db.prepare('SELECT * FROM game_sources WHERE source = ? AND source_slug = ?').get(source, sourceSlug);
  if (gs) {
    db.prepare('DELETE FROM game_sources WHERE source = ? AND source_slug = ?').run(source, sourceSlug);
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gs.game_id);
    if (g && g.slug === `${source}-${sourceSlug}` && g.origin === source
        && !db.prepare('SELECT 1 FROM user_data WHERE game_id = ?').get(g.id)) {
      db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
    }
  }
  db.prepare('UPDATE match_review SET resolved = 0 WHERE source = ? AND source_slug = ?').run(source, sourceSlug);
  res.json({ ok: true, remaining: db.prepare('SELECT count(*) c FROM match_review WHERE resolved = 0').get().c });
});

// ---------- full database export / import ----------

app.get('/api/export-db', async (req, res) => {
  const tmp = path.join(DATA_DIR, `export-tmp-${process.pid}.db`);
  try {
    await db.backup(tmp); // online backup: consistent copy even in WAL mode
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename="dosvault-${new Date().toISOString().slice(0, 10)}.db"`);
    await pipeline(fs.createReadStream(tmp), res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

app.post('/api/import-db', express.raw({ type: () => true, limit: '1gb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  const tmp = path.join(DATA_DIR, `import-tmp-${process.pid}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    // validate before touching the live database
    const src = new Database(tmp, { readonly: true, fileMustExist: true });
    let tables;
    try {
      tables = src.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
    } finally {
      src.close();
    }
    if (!tables.includes('games') || !tables.includes('user_data')) {
      throw new Error('not a Dos Vault database (games/user_data tables missing)');
    }
    // replace contents through the live connection; copy only columns both sides know
    db.prepare('ATTACH DATABASE ? AS imp').run(tmp);
    try {
      const cols = (schema, t) => db.prepare(`SELECT name FROM ${schema}.pragma_table_info(?)`).all(t).map((r) => r.name);
      db.transaction(() => {
        for (const t of ['game_tags', 'tags', 'filter_presets', 'user_data', 'scrape_state', 'game_sources', 'match_review', 'games']) db.exec(`DELETE FROM ${t}`);
        for (const t of ['games', 'tags', 'game_tags', 'filter_presets', 'user_data', 'scrape_state', 'game_sources', 'match_review']) {
          if (!tables.includes(t)) continue;
          const common = cols('main', t).filter((c) => cols('imp', t).includes(c)).join(', ');
          db.exec(`INSERT INTO main.${t} (${common}) SELECT ${common} FROM imp.${t}`);
        }
        db.exec(`INSERT INTO games_fts(games_fts) VALUES('rebuild')`);
      })();
    } finally {
      db.exec('DETACH DATABASE imp');
    }
    const games = db.prepare('SELECT count(*) c FROM games').get().c;
    const userData = db.prepare('SELECT count(*) c FROM user_data').get().c;
    res.json({ games, userData });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

app.get('/api/facets', (req, res) => {
  // facet lists honour whatever filters are passed (the client sends the current
  // ones when the "narrow filters" setting is on). Each facet omits its own
  // selection, so after picking a genre the other genres stay pickable.
  const filteredWhere = (omitKey) => {
    const q = { ...req.query };
    delete q[omitKey];
    const params = {};
    return { where: buildFilters(q, params), params };
  };
  const facet = (col, omitKey) => {
    const { where, params } = filteredWhere(omitKey);
    return db.prepare(`
      SELECT json_each.value AS v, count(*) AS c ${FROM_GAMES}, json_each(g.${col})
      ${where} GROUP BY v ORDER BY v COLLATE NOCASE ASC`).all(params);
  };
  const sourceFacet = () => {
    const { where, params } = filteredWhere('source');
    return db.prepare(`
      SELECT gs2.source AS v, count(*) AS c ${FROM_GAMES}
      JOIN game_sources gs2 ON gs2.game_id = g.id
      ${where} GROUP BY gs2.source ORDER BY gs2.source`).all(params);
  };
  const tagFacet = () => {
    const { where, params } = filteredWhere('tag');
    return db.prepare(`
      SELECT t.name AS v, count(*) AS c ${FROM_GAMES}
      JOIN game_tags gtf ON gtf.game_id = g.id JOIN tags t ON t.id = gtf.tag_id
      ${where} GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all(params);
  };
  const years = db.prepare('SELECT min(year) lo, max(year) hi FROM games WHERE year IS NOT NULL').get();
  const progress = db.prepare(`SELECT
    (SELECT count(*) FROM games) total,
    (SELECT count(*) FROM games WHERE detail_scraped = 1) scraped`).get();
  res.json({
    genres: facet('genres', 'genre'), themes: facet('themes', 'theme'),
    perspectives: facet('perspectives', 'perspective'), releasedIn: facet('released_in', 'releasedIn'),
    sources: sourceFacet(), tags: tagFacet(),
    // full list regardless of filters — the modal's tag type-ahead must see every tag
    tagNames: db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map((r) => r.name),
    years, progress,
  });
});

app.listen(config.port, () => console.log(`Dos Vault running at http://localhost:${config.port}`));
