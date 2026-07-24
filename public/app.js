const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// prefer the local copy; fall back to the site's image until it's downloaded
const imgSrc = (g) => g.thumb ? `/images/${encodeURIComponent(g.thumb)}` : (g.thumb_url || null);

let state = { tab: 'browse', page: 1 };
let currentGame = null;
let notesTimer = null;
let allTags = []; // every existing tag name, for type-ahead suggestions (kept fresh by loadFacets)

// ---------- themes ----------
const THEMES = [
  { id: 'midnight', name: 'Midnight (default)' },
  { id: 'solarized', name: 'Solarized Dark' },
  { id: 'win95', name: 'Windows 95' },
  { id: 'c64', name: 'Commodore 64' },
  { id: 'spectrum', name: 'ZX Spectrum', fx: ['scanlines'] },
  { id: 'dosblue', name: 'DOS Editor Blue', fx: ['scanlines'] },
  { id: 'cga', name: 'CGA Arcade', fx: ['scanlines', 'glow'] },
  { id: 'hercules', name: 'Hercules Mono', fx: ['scanlines', 'glow'] },
  { id: 'amber', name: 'Amber Phosphor', fx: ['scanlines', 'glow'] },
  { id: 'green', name: 'Green Phosphor', fx: ['scanlines', 'glow'] },
];

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  document.body.classList.toggle('fx-scanlines', !!(t.fx && t.fx.includes('scanlines')));
  document.body.classList.toggle('fx-glow', !!(t.fx && t.fx.includes('glow')));
  localStorage.setItem('theme', t.id);
}

$('#themeSelect').innerHTML = THEMES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
$('#themeSelect').value = localStorage.getItem('theme') || 'midnight';
applyTheme($('#themeSelect').value);
$('#themeSelect').addEventListener('change', () => applyTheme($('#themeSelect').value));
// narrow-filters setting: facet lists only show options matching the current results
const narrowFacets = () => localStorage.getItem('narrowFacets') === '1';
$('#narrowFacetsChk').checked = narrowFacets();
$('#narrowFacetsChk').addEventListener('change', () => {
  localStorage.setItem('narrowFacets', $('#narrowFacetsChk').checked ? '1' : '0');
  loadFacets();
});

$('#settingsBtn').addEventListener('click', () => { $('#settingsModal').showModal(); mountToasts(); });
$('#settingsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// ---------- export / import ----------
$('#exportBtn').addEventListener('click', () => { location.href = '/api/export'; });
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async () => {
  const f = $('#importFile').files[0];
  $('#importFile').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const res = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'HTTP ' + res.status);
    toast(`Imported ${out.imported} game(s)` + (out.missing ? `; ${out.missing} not in this catalogue` : ''));
    loadGames();
    updateShortlistCount();
  } catch (e) {
    toast('Import failed: ' + e.message, { type: 'error', ms: 8000 });
  }
});

// ---------- ambiguous match review ----------
async function openReview() {
  $('#settingsModal').close();
  const items = await (await fetch('/api/review')).json();
  const el = $('#reviewContent');
  el.innerHTML = `
    <button class="modal-close" onclick="document.getElementById('reviewModal').close()">✕ close</button>
    <h2>Ambiguous source matches (${items.length})</h2>
    <p class="review-hint">A source has an item whose title matches more than one game already in your
      catalogue. For each: is it one of those games (click it to link them), a different game entirely
      (add as new), or not worth keeping (ignore)? Use 👁 to open a candidate's full details, and
      "view ↗" to see the source item on its website. Every action can be undone.</p>
    ${items.map((it) => `
      <div class="review-item" data-source="${esc(it.source)}" data-slug="${esc(it.source_slug)}">
        <div class="review-src">
          ${it.thumb_url ? `<img loading="lazy" src="${esc(it.thumb_url)}" alt="">` : '<div class="review-noimg">?</div>'}
          <div>
            <b>${esc(it.title)}</b> ${it.year ? `(${it.year})` : ''}
            <small>on ${esc(SOURCE_NAMES[it.source] || it.source)}</small>
            <a href="${esc(it.source_url || '#')}" target="_blank" rel="noopener">view ↗</a>
          </div>
        </div>
        <div class="review-actions">
          ${it.candidates.map((c) => `
            <span class="cand-wrap">
              <button data-act="link" data-game="${c.id}" title="This source item IS this game — link them">
                ${c.thumb ? `<img loading="lazy" src="/images/${encodeURIComponent(c.thumb)}" alt="">` : ''}
                = ${esc(c.title)} ${c.year ? `(${c.year})` : ''}
              </button><a href="#" data-peek="${c.id}" title="Open this game's details">👁</a>
            </span>`).join('')}
          <button data-act="new" title="None of these — add the source item as its own catalogue entry">➕ Different game — add new</button>
          <button data-act="skip" title="Don't link or add anything">✖ Ignore</button>
        </div>
      </div>`).join('') || '<p>Nothing to review 🎉</p>'}`;
  $('#reviewModal').showModal();
  mountToasts();
}

$('#reviewBtn').addEventListener('click', openReview);

const reviewUndoHtml = new Map(); // slug -> original item markup, for undo restore

$('#reviewModal').addEventListener('click', async (e) => {
  if (e.target === e.currentTarget) return e.currentTarget.close();
  const peek = e.target.closest('[data-peek]');
  if (peek) { e.preventDefault(); return openGame(peek.dataset.peek); }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.review-item');
  const body = { source: item.dataset.source, sourceSlug: item.dataset.slug };

  if (btn.dataset.act === 'undo') {
    const res = await fetch('/api/review/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) return toast('Undo failed: ' + (out.error || res.status), { type: 'error' });
    item.innerHTML = reviewUndoHtml.get(item.dataset.slug) || '';
    updateReviewCount(out.remaining);
    loadGames();
    return;
  }

  const res = await fetch('/api/review/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action: btn.dataset.act, gameId: btn.dataset.game ? +btn.dataset.game : undefined }),
  });
  const out = await res.json();
  if (!res.ok) return toast('Resolve failed: ' + (out.error || res.status), { type: 'error' });
  const label = { link: '✔ Linked', new: '✔ Added as new game', skip: '✖ Ignored' }[btn.dataset.act];
  reviewUndoHtml.set(item.dataset.slug, item.innerHTML);
  item.innerHTML = `<div class="review-done">${label}: <b>${esc(item.querySelector('.review-src b')?.textContent || '')}</b>
    <button data-act="undo">↩ Undo</button></div>`;
  updateReviewCount(out.remaining);
  if (btn.dataset.act !== 'skip') loadGames();
});

async function updateReviewCount(n) {
  if (n === undefined) n = (await (await fetch('/api/review')).json()).length;
  $('#reviewCount').textContent = n ? `(${n})` : '';
}

// ---------- full database export / import ----------
$('#exportDbBtn').addEventListener('click', () => { location.href = '/api/export-db'; });

// importing replaces everything — require a second click to confirm
let dbConfirmTimer = null;
$('#importDbBtn').addEventListener('click', () => {
  const btn = $('#importDbBtn');
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = '⚠ Replace ALL data?';
    dbConfirmTimer = setTimeout(() => {
      btn.classList.remove('confirming');
      btn.textContent = '⬆ Import DB';
    }, 5000);
    return;
  }
  clearTimeout(dbConfirmTimer);
  btn.classList.remove('confirming');
  btn.textContent = '⬆ Import DB';
  $('#importDbFile').click();
});
$('#importDbFile').addEventListener('change', async () => {
  const f = $('#importDbFile').files[0];
  $('#importDbFile').value = '';
  if (!f) return;
  toast('Importing database...');
  try {
    const res = await fetch('/api/import-db', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'HTTP ' + res.status);
    toast(`Database replaced: ${out.games.toLocaleString()} games, ${out.userData} user entries`);
    loadFacets();
    loadGames();
    updateShortlistCount();
  } catch (e) {
    toast('Database import failed: ' + e.message, { type: 'error', ms: 8000 });
  }
});

// ---------- toasts ----------
// an open modal dialog makes everything else inert (and dims it behind its backdrop),
// so toasts must live inside the open dialog to stay visible AND clickable; they move
// back to <body> when the dialog closes
function mountToasts() {
  const wrap = $('#toasts');
  if (!wrap) return;
  const host = document.querySelector('dialog[open]') || document.body;
  if (wrap.parentElement !== host) host.appendChild(wrap);
}
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('close', () => setTimeout(mountToasts, 0)));

function toast(msg, { ms = 5000, type = '' } = {}) {
  let wrap = $('#toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toasts';
    document.body.appendChild(wrap);
  }
  mountToasts();
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>
    <button class="toast-pin" title="Pin (stays until unpinned)">📌</button>
    <button class="toast-x" title="Dismiss">✕</button>`;
  wrap.appendChild(el);
  let timer = setTimeout(dismiss, ms);
  let removeTimer = null;
  function dismiss() {
    el.classList.add('toast-out');
    removeTimer = setTimeout(() => el.remove(), 300);
  }
  el.querySelector('.toast-x').addEventListener('click', () => { clearTimeout(timer); dismiss(); });
  const pin = el.querySelector('.toast-pin');
  pin.addEventListener('click', () => {
    clearTimeout(timer);
    clearTimeout(removeTimer);
    el.classList.remove('toast-out'); // rescue a toast pinned mid-fade
    const pinned = el.classList.toggle('toast-pinned');
    pin.title = pinned ? 'Pinned — click to unpin' : 'Pin (stays until unpinned)';
    if (!pinned) timer = setTimeout(dismiss, ms);
  });
}

const FILTER_IDS = ['fGenre', 'fTheme', 'fPerspective', 'fTag', 'fReleasedIn', 'fSource', 'fYearMin', 'fYearMax', 'fMinRating', 'fMinVotes', 'fStatus', 'fSort'];

const MULTI_FILTERS = { fGenre: 'genre', fTheme: 'theme', fPerspective: 'perspective', fTag: 'tag' };

function filterParams() {
  const p = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) p.set('q', q);
  for (const [id, key] of Object.entries(MULTI_FILTERS)) {
    for (const o of $('#' + id).selectedOptions) p.append(key, o.value);
  }
  const map = {
    fReleasedIn: 'releasedIn', fSource: 'source', fYearMin: 'yearMin', fYearMax: 'yearMax',
    fMinRating: 'minRating', fMinVotes: 'minVotes', fStatus: 'status', fSort: 'sort',
  };
  for (const [id, key] of Object.entries(map)) {
    const v = $('#' + id).value;
    if (v) p.set(key, v);
  }
  if ($('#fRated').checked) p.set('rated', '1');
  if ($('#fHasNotes').checked) p.set('hasNotes', '1');
  if ($('#fInstalled').checked) p.set('installed', '1');
  if (state.tab === 'shortlist') { p.set('shortlisted', '1'); p.set('sort', 'shortlist'); p.set('includeHidden', '1'); }
  return p;
}

async function loadGames() {
  const p = filterParams();
  p.set('page', state.page);
  const res = await fetch('/api/games?' + p);
  const data = await res.json();
  renderResults(data);
  if (narrowFacets()) loadFacets(); // keep the option lists in step with the results
}

function stars(n, cls) {
  if (!n) return '';
  return `<span class="${cls}">${'★'.repeat(Math.round(n))}</span>`;
}

function renderResults(data) {
  $('#resultInfo').textContent = `${data.total.toLocaleString()} games` + (state.tab === 'shortlist' ? ' shortlisted' : '');
  const grid = $('#grid');
  if (!data.games.length) {
    grid.innerHTML = '<div class="empty">No games match. Try clearing filters.</div>';
    $('#pager').innerHTML = '';
    return;
  }
  if (state.tab === 'shortlist') {
    grid.className = 'sl-list';
    grid.innerHTML = data.games.map((g, i) => `
      <div class="sl-item" draggable="true" data-id="${g.id}">
        <span class="num">${i + 1}.</span>
        ${imgSrc(g) ? `<img src="${esc(imgSrc(g))}" alt="">` : ''}
        <span class="t" data-open="${g.id}">${esc(g.title)} <small>(${g.year ?? '?'})</small>
          ${g.my_rating ? stars(g.my_rating, 'myrating') : ''}</span>
        <button data-unshort="${g.id}" title="Remove from shortlist">✕</button>
      </div>`).join('');
    initDrag();
  } else {
    grid.className = 'grid';
    grid.innerHTML = data.games.map((g) => `
      <div class="card" data-open="${g.id}">
        ${imgSrc(g) ? `<img loading="lazy" src="${esc(imgSrc(g))}" alt="">` : '<div class="noimg">NO IMAGE</div>'}
        <div class="badges">
          ${g.shortlisted ? '<span class="badge">📌</span>' : ''}
          ${g.status !== 'none' ? `<span class="badge">${{ played: '▶', finished: '✔', abandoned: '✖', not_interested: '🚫' }[g.status] || ''}</span>` : ''}
        </div>
        <div class="info">
          <div class="title">${esc(g.title)}</div>
          <div class="meta">
            <span>${g.year ?? '?'}</span>
            <span class="crating">${g.community_rating ? g.community_rating.toFixed(1) + '★' : ''}</span>
          </div>
          ${g.my_rating ? `<div class="myrating">me: ${'★'.repeat(g.my_rating)}</div>` : ''}
        </div>
      </div>`).join('');
  }
  renderPager(data);
}

function renderPager(data) {
  const pages = Math.ceil(data.total / data.pageSize);
  const el = $('#pager');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const btns = [];
  const around = 3;
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - state.page) <= around) btns.push(i);
  }
  let html = '', prev = 0;
  for (const i of btns) {
    if (i - prev > 1) html += '<span>…</span>';
    html += `<button data-page="${i}" class="${i === state.page ? 'current' : ''}">${i}</button>`;
    prev = i;
  }
  el.innerHTML = html;
}

// ---------- detail modal ----------
async function openGame(id) {
  const res = await fetch(`/api/games/${id}`);
  currentGame = await res.json();
  renderModal();
  $('#gameModal').showModal();
  // the modal's scroll container is reused across games — don't inherit the
  // previous game's scroll position (must happen after showModal: while the
  // dialog is closed the container has no layout and the reset wouldn't stick)
  $('#modalContent').scrollTop = 0;
  mountToasts();
}

const j = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };

const SOURCE_NAMES = { myabandonware: 'My Abandonware', archiveorg: 'Internet Archive', dosgamesarchive: 'DOS Games Archive' };
// availability learned from install attempts: ✔ has the game, 📖 extras only, ✖ nothing
const AVAIL_MARK = { free: ' ✔', 'extras-only': ' 📖', none: ' ✖' };
const dlSources = (g) => j(g.sources).filter((s) => s.hasDownload && s.availability !== 'extras-only' && s.availability !== 'none');
const canInstall = (g) => j(g.sources).some((s) => s.hasDownload);
const srcLinks = (g) => {
  const links = j(g.sources).map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="availability: ${esc(s.availability)}">${
      esc(SOURCE_NAMES[s.source] || s.source)}${AVAIL_MARK[s.availability] || ''} ↗</a>`);
  return links.length ? links.join('\n') : (g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">Game page ↗</a>` : '');
};

function renderModal() {
  const g = currentGame;
  const kv = (label, val) => val ? `<div><b>${label}</b><span>${esc(val)}</span></div>` : '';
  $('#modalContent').innerHTML = `
    <button class="modal-close" onclick="document.getElementById('gameModal').close()">✕ close</button>
    <div class="modal-head">
      ${imgSrc(g) ? `<img src="${esc(imgSrc(g))}" alt="">` : ''}
      <div>
        <h2>${esc(g.title)}</h2>
        <div class="kv">
          ${kv('Year', g.year)}
          ${kv('Alt names', g.alt_names)}
          ${kv('Released in', j(g.released_in).join(', '))}
          ${kv('Genre', j(g.genres).join(', '))}
          ${kv('Theme', j(g.themes).join(', '))}
          ${kv('Perspective', j(g.perspectives).join(', '))}
          ${kv('Publisher', g.publisher)}
          ${kv('Developer', g.developer)}
          ${kv('DOSBox', g.dosbox)}
          ${g.community_rating ? `<div><b>Community</b><span><span class="crating">${g.community_rating.toFixed(2)} / 5</span> (${g.community_votes} votes)</span></div>` : ''}
          ${g.screenshot_count ? kv('Screenshots', g.screenshot_count + ' on site') : ''}
        </div>
        <div class="links">
          ${j(g.genres).length || j(g.themes).length || j(g.perspectives).length
            ? '<button id="similarBtn" title="Browse games sharing this game\'s genre, theme, or perspective">🔍 Find similar</button>' : ''}
          ${srcLinks(g)}
          ${canInstall(g) && !g.installed ? '<button id="installBtn">💾 Install</button>' : ''}
          ${canInstall(g) && !g.installed && dlSources(g).length > 1 ? `<select id="srcSelect" title="Install from">
            <option value="">Auto source</option>${dlSources(g).map((s) =>
              `<option value="${esc(s.source)}">${esc(SOURCE_NAMES[s.source] || s.source)}</option>`).join('')}</select>` : ''}
          ${g.installed && (g.executables.length || g.cd_images?.length) ? '<button id="runBtn">▶ Run</button>' : ''}
          ${g.installed && g.executables.length > 1 ? `<select id="exeSelect" title="Executable to run (💿 = on the CD image)">${g.executables.map((e) =>
            `<option value="${esc(e)}"${e === g.run_exe ? ' selected' : ''}>${e.startsWith('cd:') ? '💿 ' + esc(e.slice(3)) : esc(e)}</option>`).join('')}</select>` : ''}
          ${g.installed && g.manual ? `<a href="/api/games/${g.id}/manual" target="_blank" rel="noopener" title="${esc(g.manual)}">📖 Manual</a>` : ''}
          ${g.installed ? '<button id="uninstallBtn" title="Delete the game folder">🗑 Uninstall</button>' : ''}
        </div>
        ${g.installed ? `<div class="install-path">installed at <a href="#" id="openFolder" title="Open in file manager">${esc(g.install_path)}</a></div>` : ''}
      </div>
    </div>
    ${g.description ? `<div class="desc">${esc(g.description)}</div>` : ''}
    <div class="user-panel">
      <div class="status-row">
        <span class="stars" id="starWidget">${[1, 2, 3, 4, 5].map((n) =>
          `<span data-star="${n}" class="${g.my_rating >= n ? 'on' : ''}">★</span>`).join('')}</span>
        ${g.my_rating ? '<button id="clearRating">clear</button>' : ''}
      </div>
      <div class="status-row">
        <button class="shortlist-btn ${g.shortlisted ? 'on' : ''}" id="shortToggle">📌 ${g.shortlisted ? 'Shortlisted' : 'Add to shortlist'}</button>
        ${['played', 'finished', 'abandoned', 'not_interested'].map((s) =>
          `<button data-status="${s}" class="${g.status === s ? 'on' : ''}">${s.replace('_', ' ')}</button>`).join('')}
      </div>
      <div class="status-row tags-row">
        <span class="tags-label" title="My tags">🏷</span>
        ${j(g.tags).map((t) => `<span class="tag-chip">${esc(t)}<button data-untag="${esc(t)}" title="Remove tag">✕</button></span>`).join('')}
        <span class="tag-add">
          <input id="tagInput" placeholder="+ tag (wife, kids...)" autocomplete="off" maxlength="40">
          <div id="tagSuggest" hidden></div>
        </span>
      </div>
      <textarea id="notes" placeholder="Notes (cheats, setup quirks, memories...)">${esc(g.notes || '')}</textarea>
      <span class="save-hint" id="saveHint">notes auto-save</span>
    </div>`;

  $('#openFolder')?.addEventListener('click', (e) => {
    e.preventDefault();
    fetch(`/api/games/${g.id}/open-folder`, { method: 'POST' });
  });
  $('#similarBtn')?.addEventListener('click', () => findSimilar(g));
  $('#installBtn')?.addEventListener('click', () => installGame(g));
  $('#uninstallBtn')?.addEventListener('click', async () => {
    const btn = $('#uninstallBtn');
    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = '⚠ Delete folder?';
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('confirming');
        btn.textContent = '🗑 Uninstall';
      }, 5000);
      return;
    }
    const res = await fetch(`/api/games/${g.id}/uninstall`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return toast('Uninstall failed: ' + (data.error || res.status), { type: 'error', ms: 8000 });
    toast(`${g.title} uninstalled`);
    currentGame = data;
    renderModal();
    loadGames();
  });
  $('#runBtn')?.addEventListener('click', async () => {
    const exe = $('#exeSelect')?.value;
    const res = await fetch(`/api/games/${g.id}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exe ? { exe } : {}),
    });
    const data = await res.json();
    if (!res.ok) return toast('Run failed: ' + (data.error || res.status), { type: 'error', ms: 8000 });
    currentGame.run_exe = data.exe;
    const btn = $('#runBtn');
    btn.textContent = '▶ Launched!';
    setTimeout(() => { btn.textContent = '▶ Run'; }, 2000);
  });

  $('#starWidget').addEventListener('click', (e) => {
    const n = e.target.dataset.star;
    if (n) patchUser({ rating: +n });
  });
  $('#clearRating')?.addEventListener('click', () => patchUser({ rating: null }));
  $('#shortToggle').addEventListener('click', () => patchUser({ shortlisted: !currentGame.shortlisted }));
  document.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', () => patchUser({ status: currentGame.status === b.dataset.status ? 'none' : b.dataset.status })));
  $('.tags-row').addEventListener('click', (e) => {
    const un = e.target.closest('[data-untag]');
    if (un) return removeTag(un.dataset.untag);
    const add = e.target.closest('[data-addtag]');
    if (add) return addTag(add.dataset.addtag);
  });
  const tagInput = $('#tagInput');
  tagInput.addEventListener('input', showTagSuggestions);
  tagInput.addEventListener('focus', showTagSuggestions);
  // delay so a click on a suggestion lands before the dropdown hides
  tagInput.addEventListener('blur', () => setTimeout(() => { const s = $('#tagSuggest'); if (s) s.hidden = true; }, 200));
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = tagInput.value.trim();
      if (!v) return;
      // reuse an existing tag's exact casing when the typed name matches one
      addTag(allTags.find((t) => t.toLowerCase() === v.toLowerCase()) || v);
    } else if (e.key === 'Escape' && !$('#tagSuggest').hidden) {
      e.preventDefault(); // just close the dropdown, not the whole dialog
      $('#tagSuggest').hidden = true;
    }
  });

  $('#notes').addEventListener('input', () => {
    clearTimeout(notesTimer);
    $('#saveHint').textContent = 'saving...';
    notesTimer = setTimeout(async () => {
      await patchUser({ notes: $('#notes').value }, true);
      $('#saveHint').textContent = 'saved ✔';
    }, 600);
  });
}

// ---------- tags ----------
function showTagSuggestions() {
  const box = $('#tagSuggest');
  const v = $('#tagInput').value.trim();
  const mine = new Set(j(currentGame.tags).map((t) => t.toLowerCase()));
  const matches = allTags.filter((t) => !mine.has(t.toLowerCase())
    && (!v || t.toLowerCase().includes(v.toLowerCase())));
  const isNew = v && !allTags.some((t) => t.toLowerCase() === v.toLowerCase()) && !mine.has(v.toLowerCase());
  box.innerHTML = matches.map((t) => `<div data-addtag="${esc(t)}">🏷 ${esc(t)}</div>`).join('')
    + (isNew ? `<div data-addtag="${esc(v)}" class="tag-new">➕ create "${esc(v)}"</div>` : '');
  box.hidden = !box.innerHTML;
}

const addTag = (name) => tagRequest('POST', name);
const removeTag = (name) => tagRequest('DELETE', name);

async function tagRequest(method, name) {
  const res = await fetch(`/api/games/${currentGame.id}/tags`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) return toast('Tag update failed: ' + (data.error || res.status), { type: 'error' });
  const notesVal = $('#notes')?.value;
  currentGame = data;
  renderModal();
  if (notesVal !== undefined) $('#notes').value = notesVal;
  if (method === 'POST') $('#tagInput').focus();
  loadFacets(); // refresh the sidebar tag filter + suggestion list
  loadGames();
}

// ---------- find similar ----------
// select the game's own genres/themes/perspectives (match = shares at least one per
// facet), deliberately loose otherwise: no year constraint, best-rated first
function findSimilar(g) {
  $('#gameModal').close();
  resetFilters();
  const pick = (id, values) => {
    const set = new Set(values);
    [...$('#' + id).options].forEach((o) => { o.selected = set.has(o.value); });
  };
  pick('fGenre', j(g.genres));
  pick('fTheme', j(g.themes));
  pick('fPerspective', j(g.perspectives));
  $('#fSort').value = 'rating';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'browse'));
  state.tab = 'browse';
  state.page = 1;
  loadGames();
  window.scrollTo(0, 0);
}

// ---------- install with retro console ----------
const fmtMb = (n) => (n / 1048576).toFixed(1);

function progressText(ev) {
  if (!ev.total) return `> GET ${ev.file} ${fmtMb(ev.done)} MB`;
  const pct = Math.min(100, Math.round((ev.done / ev.total) * 100));
  const filled = Math.round(pct / 5);
  return `> GET ${ev.file} [${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${pct}% of ${fmtMb(ev.total)} MB`;
}

async function installGame(g) {
  const btn = $('#installBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Installing...';
  const con = document.createElement('pre');
  con.className = 'install-console';
  const cur = document.createElement('span');
  cur.className = 'cursor';
  cur.textContent = '█';
  con.appendChild(cur);
  $('#modalContent .modal-head').after(con);
  const line = (text) => {
    const d = document.createElement('div');
    d.textContent = text;
    con.insertBefore(d, cur);
    con.scrollTop = con.scrollHeight;
    return d;
  };
  line(`C:\\> INSTALL ${g.slug.toUpperCase().replace(/-/g, '_')}`);
  const progLines = {};
  try {
    const srcChoice = $('#srcSelect')?.value;
    const res = await fetch(`/api/games/${g.id}/install${srcChoice ? '?source=' + encodeURIComponent(srcChoice) : ''}`, { method: 'POST' });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        const ev = JSON.parse(raw);
        if (ev.type === 'log') line('> ' + ev.text);
        else if (ev.type === 'progress') {
          const l = progLines[ev.file] || (progLines[ev.file] = line(''));
          l.textContent = progressText(ev);
          con.scrollTop = con.scrollHeight;
        } else if (ev.type === 'done') {
          line('> INSTALL COMPLETE');
          if (ev.game.warning) toast(ev.game.warning, { ms: 8000 });
          toast(`${g.title} installed ✔`);
          setTimeout(() => {
            if (currentGame && currentGame.id === ev.game.id) { currentGame = ev.game; renderModal(); }
          }, 1500);
        } else if (ev.type === 'error') {
          throw new Error(ev.error);
        }
      }
    }
  } catch (e) {
    line('> ERROR: ' + e.message);
    toast('Install failed: ' + e.message, { type: 'error', ms: 8000 });
    btn.disabled = false;
    btn.textContent = '💾 Install';
  }
}

async function patchUser(fields, skipRender) {
  const res = await fetch(`/api/games/${currentGame.id}/user`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  });
  currentGame = await res.json();
  if (!skipRender) {
    const notesVal = $('#notes')?.value;
    renderModal();
    if (notesVal !== undefined) $('#notes').value = notesVal;
  }
  loadGames();
  updateShortlistCount();
}

// ---------- shortlist drag reorder ----------
function initDrag() {
  const list = $('#grid');
  let dragged = null;
  list.querySelectorAll('.sl-item').forEach((item) => {
    item.addEventListener('dragstart', () => { dragged = item; item.classList.add('dragging'); });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      const ids = [...list.querySelectorAll('.sl-item')].map((el) => +el.dataset.id);
      await fetch('/api/shortlist/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      loadGames();
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragged || dragged === item) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      list.insertBefore(dragged, before ? item : item.nextSibling);
    });
  });
}

async function updateShortlistCount() {
  const res = await fetch('/api/games?shortlisted=1&includeHidden=1');
  const data = await res.json();
  $('#shortlistCount').textContent = data.total ? `(${data.total})` : '';
}

// ---------- scrape progress ----------
async function loadFacets() {
  // narrow mode sends the current filters so lists shrink to what still matches;
  // otherwise ask for the plain global lists (includeHidden matches old behavior)
  const qs = narrowFacets() ? filterParams() : new URLSearchParams({ includeHidden: '1' });
  const res = await fetch('/api/facets?' + qs);
  const f = await res.json();
  const fill = (sel, items) => {
    const el = $(sel);
    const multi = el.multiple;
    const cur = multi ? [...el.selectedOptions].map((o) => o.value) : el.value;
    // a selected value must stay listed even when narrowing leaves it no matches
    const have = new Set(items.map((i) => i.v));
    const opts = items.concat((multi ? cur : [cur]).filter((v) => v && !have.has(v)).map((v) => ({ v, c: 0 })));
    el.innerHTML = (multi ? '' : '<option value="">All</option>') +
      opts.map((i) => `<option value="${esc(i.v)}">${esc(i.label || i.v)} (${i.c})</option>`).join('');
    if (multi) [...el.options].forEach((o) => { o.selected = cur.includes(o.value); });
    else el.value = cur;
  };
  fill('#fGenre', f.genres);
  fill('#fTheme', f.themes);
  fill('#fPerspective', f.perspectives);
  fill('#fReleasedIn', f.releasedIn);
  fill('#fSource', (f.sources || []).map((s) => ({ ...s, label: SOURCE_NAMES[s.v] || s.v })));
  allTags = f.tagNames || (f.tags || []).map((t) => t.v); // full list, for the modal type-ahead
  fill('#fTag', f.tags || []);
  $('#fTagWrap').hidden = !$('#fTag').options.length; // no point offering a filter with nothing to pick
  const pr = f.progress;
  const el = $('#scrapeProgress');
  if (pr.scraped < pr.total) {
    el.hidden = false;
    el.textContent = `scraping: ${pr.scraped.toLocaleString()}/${pr.total.toLocaleString()} games`;
  } else el.hidden = true;
}

// ---------- events ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  state.tab = t.dataset.tab;
  state.page = 1;
  loadGames();
}));

$('#surpriseBtn').addEventListener('click', async () => {
  const res = await fetch('/api/games/random?' + filterParams());
  if (!res.ok) return toast('No games match the current filters.');
  const g = await res.json();
  openGame(g.id);
});

let searchTimer = null;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.page = 1; loadGames(); }, 300);
});

FILTER_IDS.forEach((id) => $('#' + id).addEventListener('change', () => { state.page = 1; loadGames(); }));
['fRated', 'fHasNotes', 'fInstalled'].forEach((id) => $('#' + id).addEventListener('change', () => { state.page = 1; loadGames(); }));

document.querySelectorAll('.era-chips button').forEach((b) => b.addEventListener('click', () => {
  const [lo, hi] = b.dataset.era.split(',');
  $('#fYearMin').value = lo; $('#fYearMax').value = hi;
  state.page = 1; loadGames();
}));

function resetFilters() {
  $('#search').value = '';
  FILTER_IDS.forEach((id) => {
    const el = $('#' + id);
    if (el.multiple) el.selectedIndex = -1;
    else el.value = id === 'fSort' ? 'title' : '';
  });
  $('#fRated').checked = false; $('#fHasNotes').checked = false; $('#fInstalled').checked = false;
}

$('#clearFilters').addEventListener('click', () => {
  resetFilters();
  state.page = 1; loadGames();
});

document.body.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openGame(open.dataset.open);
  const pg = e.target.closest('[data-page]');
  if (pg) { state.page = +pg.dataset.page; loadGames(); window.scrollTo(0, 0); return; }
  const unshort = e.target.closest('[data-unshort]');
  if (unshort) {
    fetch(`/api/games/${unshort.dataset.unshort}/user`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortlisted: false }),
    }).then(() => { loadGames(); updateShortlistCount(); });
  }
});

// close on backdrop click — but not when releasing a resize drag: the resize handle is part
// of the dialog element itself, so require both press and release to land outside its box
const outsideDialog = (dlg, e) => {
  const r = dlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
let pressedOutside = false;
$('#gameModal').addEventListener('pointerdown', (e) => {
  pressedOutside = e.target === e.currentTarget && outsideDialog(e.currentTarget, e);
});
$('#gameModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget && pressedOutside && outsideDialog(e.currentTarget, e)) {
    e.currentTarget.close();
  }
});

loadFacets();
loadGames();
updateShortlistCount();
updateReviewCount();
setInterval(loadFacets, 60000);
