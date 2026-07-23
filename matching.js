// Shared title matching for source sync scripts: normalize names, index the
// catalogue, and match an external item by title + year (±1 when both known).
const { db } = require('./db');

// "Wolfenstein 3-D!" / "The Secret of Monkey Island" -> "wolfenstein 3 d" / "secret of monkey island"
const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(the|a|an)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function buildIndex() {
  const index = new Map();
  const add = (name, g) => {
    const n = norm(name);
    if (!n) return;
    if (!index.has(n)) index.set(n, []);
    if (!index.get(n).some((x) => x.id === g.id)) index.get(n).push(g);
  };
  for (const g of db.prepare('SELECT id, title, alt_names, year FROM games').all()) {
    add(g.title, g);
    for (const alt of String(g.alt_names || '').split(',')) add(alt, g);
  }
  return index;
}

// -> { game } | { ambiguous: [candidates] } | { unmatched: true }
function matchTitle(index, title, year) {
  let candidates = index.get(norm(title)) || [];
  if (year && candidates.length > 1) {
    const byYear = candidates.filter((g) => !g.year || Math.abs(g.year - year) <= 1);
    if (byYear.length) candidates = byYear;
  }
  if (year && candidates.length === 1 && candidates[0].year && Math.abs(candidates[0].year - year) > 1) {
    return { unmatched: true }; // same name, clearly different era
  }
  if (!candidates.length) return { unmatched: true };
  if (candidates.length > 1) return { ambiguous: candidates };
  return { game: candidates[0] };
}

module.exports = { norm, buildIndex, matchTitle };
