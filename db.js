const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  alt_names TEXT,
  year INTEGER,
  released_in TEXT,
  genres TEXT,
  themes TEXT,
  perspectives TEXT,
  publisher TEXT,
  developer TEXT,
  dosbox TEXT,
  description TEXT,
  community_rating REAL,
  community_votes INTEGER,
  thumb TEXT,
  thumb_url TEXT,
  screenshot_count INTEGER,
  download_url TEXT,
  detail_scraped INTEGER DEFAULT 0,
  scrape_error TEXT
);

CREATE TABLE IF NOT EXISTS user_data (
  game_id INTEGER PRIMARY KEY REFERENCES games(id),
  rating INTEGER,
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'none',
  shortlisted INTEGER DEFAULT 0,
  shortlist_order INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS scrape_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_year ON games(year);
CREATE INDEX IF NOT EXISTS idx_games_scraped ON games(detail_scraped);

CREATE VIRTUAL TABLE IF NOT EXISTS games_fts USING fts5(
  title, alt_names, description, content='games', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS games_ai AFTER INSERT ON games BEGIN
  INSERT INTO games_fts(rowid, title, alt_names, description)
  VALUES (new.id, new.title, coalesce(new.alt_names,''), coalesce(new.description,''));
END;
CREATE TRIGGER IF NOT EXISTS games_au AFTER UPDATE ON games BEGIN
  INSERT INTO games_fts(games_fts, rowid, title, alt_names, description)
  VALUES ('delete', old.id, old.title, coalesce(old.alt_names,''), coalesce(old.description,''));
  INSERT INTO games_fts(rowid, title, alt_names, description)
  VALUES (new.id, new.title, coalesce(new.alt_names,''), coalesce(new.description,''));
END;
CREATE TRIGGER IF NOT EXISTS games_ad AFTER DELETE ON games BEGIN
  INSERT INTO games_fts(games_fts, rowid, title, alt_names, description)
  VALUES ('delete', old.id, old.title, coalesce(old.alt_names,''), coalesce(old.description,''));
END;
`);

// lightweight migrations for columns added after initial release
const userCols = db.prepare('PRAGMA table_info(user_data)').all().map((c) => c.name);
if (!userCols.includes('install_path')) db.exec('ALTER TABLE user_data ADD COLUMN install_path TEXT');
if (!userCols.includes('run_exe')) db.exec('ALTER TABLE user_data ADD COLUMN run_exe TEXT');

// which source first contributed a game to the catalogue; the myabandonware
// scraper must only re-crawl its own rows
const gameCols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
if (!gameCols.includes('origin')) db.exec(`ALTER TABLE games ADD COLUMN origin TEXT DEFAULT 'myabandonware'`);

// items a source sync could not uniquely match to a catalogue game: kept for review
db.exec(`
CREATE TABLE IF NOT EXISTS match_review (
  source TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  title TEXT,
  year INTEGER,
  candidates TEXT,
  source_url TEXT,
  download_url TEXT,
  thumb_url TEXT,
  resolved INTEGER DEFAULT 0,
  PRIMARY KEY (source, source_slug)
);
`);
const reviewCols = db.prepare('PRAGMA table_info(match_review)').all().map((c) => c.name);
for (const col of ['source_url', 'download_url', 'thumb_url']) {
  if (!reviewCols.includes(col)) db.exec(`ALTER TABLE match_review ADD COLUMN ${col} TEXT`);
}
// backfill rows written before these columns existed (archive.org URLs are derivable)
db.exec(`
UPDATE match_review SET
  source_url = 'https://archive.org/details/' || source_slug,
  download_url = 'https://archive.org/download/' || source_slug,
  thumb_url = 'https://archive.org/services/img/' || source_slug
WHERE source = 'archiveorg' AND source_url IS NULL;
`);

// per-site availability of each game; a game can exist on several sources.
// availability: 'free' | 'extras-only' (manual etc. but no game) | 'none' | 'unknown'
db.exec(`
CREATE TABLE IF NOT EXISTS game_sources (
  game_id INTEGER NOT NULL REFERENCES games(id),
  source TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  source_url TEXT NOT NULL,
  download_url TEXT,
  availability TEXT DEFAULT 'unknown',
  last_checked TEXT,
  PRIMARY KEY (source, source_slug)
);
CREATE INDEX IF NOT EXISTS idx_game_sources_game ON game_sources(game_id);
`);
// seed/sync from the legacy single-source columns on games (idempotent, runs every boot);
// only myabandonware-origin rows — games contributed by other sources have no page there
db.exec(`
INSERT INTO game_sources (game_id, source, source_slug, source_url, download_url, availability)
SELECT id, 'myabandonware', slug, url, download_url,
  CASE WHEN download_url IS NULL THEN 'none' ELSE 'unknown' END
FROM games g
WHERE g.origin = 'myabandonware' AND NOT EXISTS (
  SELECT 1 FROM game_sources s WHERE s.source = 'myabandonware' AND s.source_slug = g.slug
);
DELETE FROM game_sources WHERE source = 'myabandonware'
  AND game_id IN (SELECT id FROM games WHERE origin != 'myabandonware');
`);

// user-defined tags ("wife", "kids", ...); names are case-insensitively unique
db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS game_tags (
  game_id INTEGER NOT NULL REFERENCES games(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (game_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_game_tags_tag ON game_tags(tag_id);
`);

module.exports = { db, DATA_DIR, IMAGES_DIR };
