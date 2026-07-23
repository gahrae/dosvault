// Source adapter for the Internet Archive MS-DOS software library.
// Implements the contract documented in sources/myabandonware.js.
// source_slug is the archive.org item identifier; everything comes from the
// JSON metadata API — no HTML scraping.
const UA = 'dosvault/1.0 (personal catalogue; contact: local use)';

async function resolveDownloads(src, { log } = {}) {
  const id = src.source_slug;
  log?.(`GET /metadata/${id}`);
  const r = await fetch(`https://archive.org/metadata/${id}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`archive.org metadata failed (HTTP ${r.status})`);
  const meta = await r.json();
  const files = (meta.files || []).filter((f) => f.source === 'original' && !/^_/.test(f.name));

  // the game is the original zip — or a .play bundle, which is a zip in disguise —
  // largest first when an item carries several; pdfs / *manual* count as documentation
  const zips = files.filter((f) => /\.(zip|play)$/i.test(f.name))
    .sort((a, b) => (+b.size || 0) - (+a.size || 0));
  const manuals = files.filter((f) => !/\.(zip|play)$/i.test(f.name) && (/manual/i.test(f.name) || /\.pdf$/i.test(f.name)));

  const mk = (f) => ({
    desc: `${f.name}${f.size ? ` ${(+f.size / 1048576).toFixed(1)} MB` : ''}`,
    version: null,
    lang: null,
    resolve: async () => ({
      url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
      headers: { 'User-Agent': UA },
    }),
  });

  return {
    availability: zips.length ? 'free' : (manuals.length ? 'extras-only' : 'none'),
    buyLinks: [],
    gameFiles: zips.map(mk),
    manuals: manuals.map(mk),
    totalGameFiles: zips.length,
  };
}

module.exports = { id: 'archiveorg', name: 'Internet Archive', resolveDownloads };
