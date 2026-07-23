// Source adapter for dosgamesarchive.com.
// Implements the contract documented in sources/myabandonware.js.
// Game pages live at /download/<slug>; each file row links a /file/<slug>/<name>
// page whose download button points at /file.php?id=N, which 302s to the zip.
const cheerio = require('cheerio');

const SITE = 'https://www.dosgamesarchive.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchPage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error(`dosgamesarchive fetch failed (HTTP ${r.status}) for ${url}`);
  return r.text();
}

// parse the files table of a game page -> [{ name, href, license, size }]
function parseFiles($) {
  const files = [];
  $('#table_container_files tbody tr').each((_, tr) => {
    const a = $(tr).find('a[href^="/file/"]').first();
    if (!a.length) return;
    files.push({
      name: a.text().trim(),
      href: new URL(a.attr('href'), SITE).href,
      license: $(tr).find('a[href^="/license/"]').first().text().trim() || null,
      size: ($(tr).text().match(/[\d.]+\s*[kMG]B/) || [null])[0],
    });
  });
  return files;
}

async function resolveDownloads(src, { log } = {}) {
  log?.(`GET ${new URL(src.source_url).pathname}`);
  const $ = cheerio.load(await fetchPage(src.source_url));
  const files = parseFiles($);

  const isDemo = (f) => /demo/i.test(f.license || '');
  const isDoc = (f) => /manual|\.pdf$/i.test(f.name);
  const gameFiles = files.filter((f) => !isDoc(f)).sort((a, b) => isDemo(a) - isDemo(b));
  const manuals = files.filter(isDoc);

  const mk = (f) => ({
    desc: [f.name, f.license, f.size].filter(Boolean).join(' · '),
    version: null,
    lang: null,
    resolve: async () => {
      // file page -> /file.php?id=N -> 302 to the real zip on their CDN
      const f$ = cheerio.load(await fetchPage(f.href));
      const dl = f$('#button_download').attr('href') || f$('a[href^="/file.php"]').attr('href');
      if (!dl) throw new Error(`no download button on ${f.href}`);
      const r = await fetch(new URL(dl, SITE).href, {
        redirect: 'manual', headers: { 'User-Agent': UA },
      });
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`no redirect from ${dl} (HTTP ${r.status})`);
      return { url: new URL(loc, SITE).href, headers: { 'User-Agent': UA } };
    },
  });

  return {
    availability: gameFiles.some((f) => !isDemo(f)) ? 'free'
      : (gameFiles.length || manuals.length ? 'extras-only' : 'none'),
    buyLinks: $('a.button.buy').map((_, a) => ({ store: $(a).text().replace(/^buy\s*(on|at)?\s*/i, '').trim() || 'store', url: $(a).attr('href') })).get(),
    gameFiles: gameFiles.map(mk),
    manuals: manuals.map(mk),
    totalGameFiles: gameFiles.length,
  };
}

module.exports = { id: 'dosgamesarchive', name: 'DOS Games Archive', resolveDownloads, parseFiles, SITE, UA, fetchPage };
