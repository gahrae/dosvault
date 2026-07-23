// Source adapter for myabandonware.com.
//
// Adapter contract (every file in sources/ implements this):
//   id, name
//   resolveDownloads(sourceRow, { log }) -> {
//     availability: 'free' | 'extras-only' | 'none',
//     buyLinks:  [{ store, url }],
//     gameFiles: [{ desc, version, lang, resolve: async () => ({ url, headers }) }],  best first
//     manuals:   [same shape],
//   }
// resolve() returns a direct file URL plus the headers needed to fetch it.
const cheerio = require('cheerio');

const SITE = 'https://www.myabandonware.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// the site's own JS fetches a /download/ URL as XHR to get JSON {url} with the tokenized file link
async function resolveFileUrl(dlUrl, referer, cookies) {
  const r = await fetch(dlUrl, {
    redirect: 'manual',
    headers: {
      'User-Agent': UA, 'X_REQUESTED_WITH': 'XMLHttpRequest', 'Referer': referer,
      ...(cookies && { Cookie: cookies }),
    },
  });
  if (r.status !== 200) throw new Error(`site did not return a file link for ${dlUrl} (HTTP ${r.status})`);
  const url = (await r.json()).url;
  if (!url) throw new Error(`no file URL in site response for ${dlUrl}`);
  return url;
}

// prefer English (or unflagged) files, and among those the highest version number
const english = (list) => {
  const en = list.filter((x) => !x.lang || /english/i.test(x.lang));
  return en.length ? en : list;
};
const vcmp = (a, b) => {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
};

async function resolveDownloads(src, { log } = {}) {
  const pageUrl = src.source_url;
  log?.(`GET ${new URL(pageUrl).pathname}`);
  // the stored download_url can point at a manual instead of the game (games pulled from
  // the site because they are sold again only offer extras), so parse the live page, which
  // distinguishes game files (a.button.download) from manuals (a.button.manual)
  const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  const cookies = pageRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const $ = cheerio.load(await pageRes.text());

  // download boxes are split into per-platform sections (h4.platformDownload); walk the
  // buttons in document order and keep only those before any platform header or under DOS.
  // each button's next sibling span carries description, "Version N" and a language flag.
  const games = [];
  const manuals = [];
  let platform = null;
  $('h4.platformDownload, a.button.download, a.button.manual').each((_, el) => {
    if (el.tagName === 'h4') { platform = $(el).attr('id') || $(el).text(); return; }
    if (platform !== null && !/^dos/i.test(platform)) return;
    const href = $(el).attr('href');
    if (!href) return;
    const span = $(el).next('span');
    const text = span.text().trim().replace(/\s+/g, ' ');
    ($(el).hasClass('manual') ? manuals : games).push({
      href: new URL(href, SITE).href,
      desc: text,
      version: (text.match(/\bv(?:ersion)?\s*([\d.]+)/i) || [])[1] || null,
      lang: span.find('img[alt$="version"]').attr('alt') || null,
    });
  });
  if (!games.length && !manuals.length && src.download_url) {
    games.push({ href: src.download_url, desc: '', version: null, lang: null });
  }

  const buyLinks = $('.buyLinks a').map((_, a) => ({
    store: ($(a).text().match(/on\s+(.+)$/i) || [, $(a).text().trim()])[1],
    url: $(a).attr('href'),
  })).get();

  const withResolve = (f) => ({
    ...f,
    resolve: async () => ({
      url: await resolveFileUrl(f.href, pageUrl, cookies),
      headers: { 'User-Agent': UA, ...(cookies && { Cookie: cookies }) },
    }),
  });

  const bestFirst = english(games).sort((a, b) => vcmp(b.version || 0, a.version || 0));
  return {
    availability: games.length ? 'free' : (manuals.length ? 'extras-only' : 'none'),
    buyLinks,
    gameFiles: bestFirst.map(withResolve),
    manuals: english(manuals).map(withResolve),
    totalGameFiles: games.length,
  };
}

module.exports = { id: 'myabandonware', name: 'My Abandonware', resolveDownloads };
