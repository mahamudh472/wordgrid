'use strict';
/* Wordgrid — static, no build. State lives in localStorage. */

const KEY = 'wordgrid.v1';
const PALETTE = ['#ef6a5b', '#4c8df6', '#3cb97a', '#f2a93b', '#9b6bdc', '#e8588f', '#2bb5c4', '#8a9a3b'];
const DICT_URL = 'https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt';
const COMMON_URL = 'https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english-no-swears.txt';
const API_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MIN_LEN = 2;
const BONUS_SECS = 5;

const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && el.append(c));
  return el;
}

/* ---------------- state ---------------- */
function fresh() {
  return {
    phase: 'setup',
    setup: { mode: 'multi', level: 'medium', bot: { name: 'Bot', color: PALETTE[1] }, n: 2, secs: 30, players: PALETTE.map((c, i) => ({ name: 'User' + (i + 1), color: c })) },
    players: [], cur: 0, turnNo: 0, turnSecs: 0, turnEnd: null,
    cells: {},        // "x,y" -> {c:'A', p:playerIndex}
    marks: [],        // {a:[x,y], b:[x,y], p, word}
    words: [],        // claimed words (uppercase)
    locked: false,     // true once a word was scored this turn: letter can no longer change
    placed: null,     // key of the letter placed this turn
    view: { x: null, y: null, size: 56 },
    detail: false,
  };
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.phase) { const f = Object.assign(fresh(), s); f.setup = Object.assign(fresh().setup, s.setup); return f; } } catch (e) { }
  return fresh();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } }

let S = load();
// transient UI state
let sel = null, markMode = false, markSel = null, busy = false;

/* ---------------- dictionary ---------------- */
let dict = null, dictState = 'idle', dictPromise = null;
function loadDict() {
  if (dictPromise) return dictPromise;
  dictState = 'loading'; badge();
  dictPromise = fetch(DICT_URL)
    .then((r) => { if (!r.ok) throw 0; return r.text(); })
    .then((t) => { dict = new Set(t.split(/\s+/)); dictState = 'ready'; })
    .catch(() => { dictState = 'failed'; dictPromise = null; })
    .finally(badge);
  return dictPromise;
}
// Frequency-ordered common words (rank 0 = most common). Used so the bot sticks to words people know.
let common = null, commonPromise = null;
function loadCommon() {
  if (commonPromise) return commonPromise;
  commonPromise = fetch(COMMON_URL)
    .then((r) => { if (!r.ok) throw 0; return r.text(); })
    .then((t) => { common = new Map(t.split(/\s+/).filter(Boolean).map((w, i) => [w, i])); })
    .catch(() => { commonPromise = null; });
  return commonPromise;
}
async function isWord(word) {
  const w = word.toLowerCase();
  if (!dict) await loadDict();
  if (dict) return dict.has(w);               // offline-fast path: local set from CDN list
  const r = await fetch(API_URL + encodeURIComponent(w)); // fallback: online dictionary API
  if (r.status === 404) return false;
  if (!r.ok) throw new Error('api');
  return true;
}
function badge() {
  const b = $('#dictBadge');
  b.hidden = dictState === 'ready' || dictState === 'idle';
  b.className = 'badge' + (dictState === 'failed' ? ' bad' : '');
  b.textContent = dictState === 'failed' ? 'Dictionary offline · using API' : 'Loading dictionary…';
}

/* ---------------- helpers ---------------- */
const k = (x, y) => x + ',' + y;
const cur = () => S.players[S.cur];
const isBot = () => S.phase === 'play' && !!(cur() && cur().bot);
let toastT;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function setTint() { document.documentElement.style.setProperty('--pc', S.phase === 'play' && cur() ? cur().color : '#999999'); }

/* ================= SETUP ================= */
function renderSetup() {
  const bot = S.setup.mode === 'bot';
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.setup.mode));
  document.querySelectorAll('#lvlSeg button').forEach((b) => b.classList.toggle('on', b.dataset.level === S.setup.level));
  $('#playersRow').hidden = bot; $('#levelRow').hidden = !bot;
  $('#count').textContent = S.setup.n;
  $('#secs').value = S.setup.secs ?? 30;
  const list = $('#plist'); list.innerHTML = '';
  const count = bot ? 2 : S.setup.n;
  for (let i = 0; i < count; i++) {
    const isBotRow = bot && i === 1;
    const p = isBotRow ? S.setup.bot : S.setup.players[i];
    const row = h('div', { class: 'prow', style: `--c:${p.color};animation-delay:${i * 40}ms` });
    const inp = h('input', { type: 'text', value: p.name, maxlength: 16, placeholder: isBotRow ? 'Bot' : 'User' + (i + 1), 'aria-label': 'Player ' + (i + 1) + ' name' });
    inp.addEventListener('input', () => { p.name = inp.value; save(); });
    const col = h('input', { type: 'color', value: p.color, 'aria-label': 'Player ' + (i + 1) + ' color' });
    col.addEventListener('input', () => { p.color = col.value; row.style.setProperty('--c', col.value); save(); });
    row.append(inp, h('label', { class: 'swatch' }, h('i'), col));
    list.append(row);
  }
}
document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => { S.setup.mode = b.dataset.mode; save(); renderSetup(); }));
document.querySelectorAll('#lvlSeg button').forEach((b) => (b.onclick = () => { S.setup.level = b.dataset.level; save(); renderSetup(); }));
$('#plus').onclick = () => { if (S.setup.n < 8) { S.setup.n++; save(); renderSetup(); } };
$('#minus').onclick = () => { if (S.setup.n > 2) { S.setup.n--; save(); renderSetup(); } };
$('#secs').addEventListener('input', (e) => { S.setup.secs = e.target.value; save(); });
$('#start').onclick = () => {
  const secs = Math.max(0, Math.min(600, parseInt(S.setup.secs, 10) || 0));
  if (S.setup.mode === 'bot') {
    const me = S.setup.players[0], bt = S.setup.bot;
    S.players = [{ name: me.name.trim() || 'User1', color: me.color, score: 0 }, { name: bt.name.trim() || 'Bot', color: bt.color, score: 0, bot: true }];
  } else S.players = S.setup.players.slice(0, S.setup.n).map((p, i) => ({ name: p.name.trim() || 'User' + (i + 1), color: p.color, score: 0 }));
  S.level = S.setup.level;
  Object.assign(S, { phase: 'play', locked: false, cur: 0, turnNo: 0, turnSecs: secs, turnEnd: secs ? Date.now() + secs * 1000 : null, cells: {}, marks: [], words: [], placed: null, view: { x: null, y: null, size: window.innerWidth < 520 ? 48 : 56 } });
  sel = null; markMode = false; markSel = null;
  save(); show();
};

/* ================= GAME ================= */
const board = $('#board'), world = $('#world'), dock = $('#dock');
const tiles = new Map(), markEls = [];
let cursorEl = null, previewEl = null;

function show() {
  if (S.phase === 'play' && S.players.some((p) => p.bot)) loadCommon();
  $('#setup').hidden = S.phase !== 'setup';
  $('#game').hidden = S.phase !== 'play';
  setTint();
  if (S.phase === 'setup') renderSetup();
  else { loadDict(); initView(); renderAll(); if (isBot()) botTurn(); }
}
function initView() {
  const v = S.view;
  if (v.x == null) { v.x = board.clientWidth / 2 - v.size / 2; v.y = (board.clientHeight - 120) / 2 - v.size / 2; }
}

function renderAll() { setTint(); renderScore(); renderBoard(); renderDock(); applyView(); }

/* ---- scoreboard ---- */
let lastScores = [];
function renderScore() {
  const el = $('#score');
  el.className = 'score' + (S.detail ? '' : ' min');
  el.innerHTML = '';
  S.players.forEach((p, i) => {
    const row = h('div', { class: 'sc' + (i === S.cur ? ' cur' : '') + (lastScores.length && lastScores[i] !== p.score ? ' bump' : ''), style: `--c:${p.color}` },
      h('span', { class: 'dot' }),
      S.detail ? h('span', { class: 'nm' }, p.name) : null,
      h('span', { class: 'pt' }, String(p.score)));
    el.append(row);
  });
  lastScores = S.players.map((p) => p.score);
}
$('#score').onclick = () => { S.detail = !S.detail; save(); renderScore(); };

/* ---- board ---- */
function applyView() {
  const v = S.view;
  world.style.transform = `translate(${v.x}px,${v.y}px)`;
  board.style.backgroundSize = `${v.size}px ${v.size}px`;
  board.style.backgroundPosition = `${v.x}px ${v.y}px`;
  board.style.setProperty('--s', v.size + 'px');
}
const pos = (el, x, y) => { el.style.left = x * S.view.size + 'px'; el.style.top = y * S.view.size + 'px'; };

function lineRect(a, b) {
  const s = S.view.size, x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const w = Math.abs(a[0] - b[0]) + 1, hh = Math.abs(a[1] - b[1]) + 1, pad = 1;
  return `left:${x0 * s + pad}px;top:${y0 * s + pad}px;width:${w * s - pad * 2}px;height:${hh * s - pad * 2}px`;
}
function renderBoard() {
  const s = S.view.size;
  board.style.setProperty('--s', s + 'px');
  // tiles
  for (const [key, el] of tiles) if (!S.cells[key]) { el.remove(); tiles.delete(key); }
  for (const [key, cell] of Object.entries(S.cells)) {
    let el = tiles.get(key);
    const [x, y] = key.split(',').map(Number);
    if (!el) { el = h('div', { class: 'tile' }); world.append(el); tiles.set(key, el); }
    el.textContent = cell.c;
    el.style.setProperty('--c', S.players[cell.p].color);
    pos(el, x, y);
    el.classList.toggle('mine', key === S.placed && !S.locked);
    el.classList.toggle('sel', !!sel && key === k(sel.x, sel.y));
  }
  // marks (only animate new ones)
  while (markEls.length > S.marks.length) markEls.pop().remove();
  S.marks.forEach((m, i) => {
    let el = markEls[i];
    if (!el) { el = h('div', { class: 'mark' }); world.append(el); markEls[i] = el; }
    el.style.cssText = lineRect(m.a, m.b) + `;--c:${S.players[m.p].color}`;
  });
  // cursor (selected empty cell)
  if (sel && !S.cells[k(sel.x, sel.y)]) {
    if (!cursorEl) { cursorEl = h('div', { class: 'cursor' }); world.append(cursorEl); }
    pos(cursorEl, sel.x, sel.y);
  } else if (cursorEl) { cursorEl.remove(); cursorEl = null; }
  // preview
  if ((markMode || isBot()) && markSel) {
    if (!previewEl) { previewEl = h('div', { class: 'mark preview' }); world.append(previewEl); }
    previewEl.style.cssText = lineRect(markSel.a, markSel.b) + `;--c:${cur().color}`;
  } else if (previewEl) { previewEl.remove(); previewEl = null; }
  board.classList.toggle('marking', markMode);
}

function floatText(txt, x, y, color) {
  const el = h('div', { class: 'float', style: `--c:${color}` }, txt);
  pos(el, x, y); el.style.marginLeft = S.view.size * .3 + 'px';
  world.append(el); setTimeout(() => el.remove(), 1400);
}

/* ---- pointer interaction ---- */
const cellAt = (e) => {
  const r = board.getBoundingClientRect(), v = S.view;
  return [Math.floor((e.clientX - r.left - v.x) / v.size), Math.floor((e.clientY - r.top - v.y) / v.size)];
};
let drag = null;
board.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  board.setPointerCapture(e.pointerId);
  const c = cellAt(e);
  const onLetter = !!S.cells[k(c[0], c[1])] && !isBot();
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: S.view.x, oy: S.view.y, c, moved: false, mode: markMode && onLetter ? 'mark' : 'pan' };
  if (drag.mode === 'mark') { markSel = { a: c, b: c }; renderBoard(); renderDock(); }
});
board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; if (drag.mode === 'pan') board.classList.add('dragging'); }
  if (drag.mode === 'pan') {
    if (drag.moved) { S.view.x = drag.ox + dx; S.view.y = drag.oy + dy; applyView(); }
  } else {
    const c = cellAt(e), a = drag.c, ddx = c[0] - a[0], ddy = c[1] - a[1];
    let b = Math.abs(ddx) >= Math.abs(ddy) ? [c[0], a[1]] : [a[0], c[1]]; // lock to a straight line
    drag.reversed = b[0] < a[0] || b[1] < a[1];                              // only left→right / top→bottom
    if (drag.reversed) b = a;
    if (!markSel || markSel.b[0] !== b[0] || markSel.b[1] !== b[1]) { markSel = { a, b }; renderBoard(); renderDock(); }
  }
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null; board.classList.remove('dragging');
  if (d.mode === 'pan') {
    if (d.moved) save(); else tapCell(d.c);
  } else if (d.reversed) toast('Words read left → right or top → bottom', 'err');
};
board.addEventListener('pointerup', endDrag);
board.addEventListener('pointercancel', endDrag);
board.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY); }, { passive: false });

function tapCell([x, y]) {
  if (markMode || isBot()) return;
  const key = k(x, y), cell = S.cells[key];
  if (S.locked) { if (!cell) toast('Your letter is locked after marking a word', 'err'); return; }
  if (cell && key !== S.placed) return;       // can only edit this turn's own letter
  sel = { x, y };
  renderBoard(); renderDock(); ensureVisible();
}
function ensureVisible() {
  if (!sel) return;
  const v = S.view, top = board.clientHeight - dock.offsetHeight - 24 - v.size;
  const sy = v.y + sel.y * v.size;
  if (sy > top) { v.y -= sy - top; applyView(); save(); }
}

/* ---- zoom ---- */
function zoom(f, cx = board.clientWidth / 2, cy = board.clientHeight / 2) {
  const v = S.view, ns = Math.max(28, Math.min(96, v.size * f));
  const wx = (cx - v.x) / v.size, wy = (cy - v.y) / v.size;
  v.size = ns; v.x = cx - wx * ns; v.y = cy - wy * ns;
  renderBoard(); applyView(); save();
}
$('#zoomIn').onclick = () => zoom(1.2);
$('#zoomOut').onclick = () => zoom(1 / 1.2);
$('#recenter').onclick = () => {
  const keys = Object.keys(S.cells), v = S.view;
  let cx = 0, cy = 0;
  if (keys.length) { keys.forEach((q) => { const [x, y] = q.split(',').map(Number); cx += x; cy += y; }); cx /= keys.length; cy /= keys.length; }
  v.x = board.clientWidth / 2 - (cx + .5) * v.size; v.y = (board.clientHeight - 120) / 2 - (cy + .5) * v.size;
  world.style.transition = 'transform .4s cubic-bezier(.2,.8,.2,1)'; applyView();
  setTimeout(() => (world.style.transition = ''), 450); save();
};

/* ---- placing letters ---- */
function placeLetter(ch) {
  if (!sel || S.locked) return;
  const key = k(sel.x, sel.y), ex = S.cells[key];
  if (ex && key !== S.placed) return toast('That box is taken', 'err');
  if (S.placed && S.placed !== key) delete S.cells[S.placed]; // one letter per turn: moving it
  S.cells[key] = { c: ch.toUpperCase(), p: S.cur };
  S.placed = key; sel = null;
  if (tiles.has(key)) { const t = tiles.get(key); t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; }
  save(); renderBoard(); renderDock();
}
function removeLetter() {
  if (!S.placed || S.locked) return;
  delete S.cells[S.placed]; S.placed = null; sel = null;
  save(); renderBoard(); renderDock();
}
function moveSel(dx, dy) {
  if (!sel) return;
  sel = { x: sel.x + dx, y: sel.y + dy };
  const key = k(sel.x, sel.y);
  if (S.cells[key] && key !== S.placed) return moveSel(dx, dy);
  renderBoard(); renderDock(); ensureVisible();
}
document.addEventListener('keydown', (e) => {
  if (S.phase !== 'play' || isBot() || e.ctrlKey || e.metaKey || e.altKey || !$('#sheet').hidden) return;
  if (/^[a-zA-Z]$/.test(e.key) && sel) { placeLetter(e.key); e.preventDefault(); }
  else if (e.key === 'Backspace' || e.key === 'Delete') removeLetter();
  else if (e.key === 'Escape') { sel = null; if (markMode) cancelMark(); else { renderBoard(); renderDock(); } }
  else if (e.key === 'Enter' && markMode && markSel) doneMark();
  else if (e.key.startsWith('Arrow') && sel) {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    moveSel(...d); e.preventDefault();
  }
});

/* ---- marking words ---- */
function pathCells(m) {
  const [ax, ay] = m.a, [bx, by] = m.b, n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) + 1;
  const sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
  return Array.from({ length: n }, (_, i) => [ax + sx * i, ay + sy * i]);
}
const wordFrom = (m) => pathCells(m).map(([x, y]) => (S.cells[k(x, y)] || { c: '?' }).c).join('');

function startMark() {
  if (isBot()) return; markMode = true; markSel = null; sel = null; renderBoard(); renderDock(); }
function cancelMark() { markMode = false; markSel = null; busy = false; renderBoard(); renderDock(); }
function fail(msg) {
  toast(msg, 'err');
  if (previewEl) { previewEl.classList.remove('shake'); void previewEl.offsetWidth; previewEl.classList.add('shake'); }
}
async function doneMark() {
  if (busy || !markSel || isBot()) return;
  const w = wordFrom(markSel);
  if (w.includes('?')) return fail('Every box in the line needs a letter');
  if (w.length < MIN_LEN) return fail(`Select at least ${MIN_LEN} letters`);
  if (S.words.includes(w)) return penalize(`"${w}" was already taken`);
  busy = true; renderDock();
  const turn = S.turnNo;
  let ok;
  try { ok = await isWord(w); }
  catch (e) { if (S.turnNo !== turn) return; busy = false; renderDock(); return fail('Could not reach the dictionary'); }
  if (S.turnNo !== turn) return;               // time ran out while checking
  busy = false;
  if (!ok) return penalize(`"${w}" is not a valid word`);
  claim(w, markSel.a, markSel.b);
}
function claim(w, a, b) {
  const p = cur(), m = { a, b, p: S.cur, word: w };
  S.words.push(w); S.marks.push(m); p.score += w.length;
  floatText('+' + w.length, b[0], b[1], p.color);
  toast(`${p.name} claimed ${w} (+${w.length})${S.turnEnd ? ' · +' + BONUS_SECS + 's' : ''}`, 'ok');
  if (S.turnEnd) S.turnEnd += BONUS_SECS * 1000;   // reward: extra time, turn continues
  S.locked = true; markMode = false; markSel = null;
  save(); renderAll();
}
function penalize(msg) {
  const p = cur(), end = markSel.b;
  p.score -= 1;
  floatText('−1', end[0], end[1], '#c0392b');
  toast(`${msg} · ${p.name} −1 point`, 'err');
  nextTurn(true);
}
function nextTurn(silent) {
  S.cur = (S.cur + 1) % S.players.length;
  S.turnNo++; S.locked = false; S.turnEnd = S.turnSecs && !cur().bot ? Date.now() + S.turnSecs * 1000 : null;
  S.placed = null; sel = null; markMode = false; markSel = null; busy = false;
  save(); renderAll();
  if (!silent) toast(`${cur().name}'s turn`);
  if (isBot()) botTurn();
}

/* ---- dock ---- */
function renderDock() {
  const p = cur(); dock.innerHTML = '';
  const hint = isBot() ? 'Thinking…' : sel ? 'Pick a letter for this box'
    : markMode ? 'Drag left → right or top → bottom'
    : S.locked ? 'Letter locked · mark more words or end turn'
    : S.placed ? 'Letter placed · mark a word or end turn' : 'Tap an empty box to place a letter (required to end turn)';
  dock.append(h('div', { class: 'dtop' }, h('span', { class: 'dot' }),
    h('div', { class: 'grow' }, h('b', {}, `${p.name}'s turn`), h('small', {}, hint)),
    S.turnEnd ? h('span', { class: 'timer', id: 'timer' }) : null));
  tick();
  if (isBot()) return;

  if (sel) {
    const rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
    const kb = h('div', { class: 'kb' });
    rows.forEach((r, i) => {
      const row = h('div', { class: 'kr' });
      if (i === 2) row.append(h('button', { class: 'key wide', 'aria-label': 'Close', onclick: () => { sel = null; renderBoard(); renderDock(); } }, '✕'));
      [...r].forEach((ch) => row.append(h('button', { class: 'key', onclick: () => placeLetter(ch) }, ch)));
      if (i === 2) row.append(h('button', { class: 'key wide', 'aria-label': 'Remove letter', onclick: removeLetter }, '⌫'));
      kb.append(row);
    });
    dock.append(kb);
  } else if (markMode) {
    if (markSel) dock.append(h('div', { class: 'wordprev' }, wordFrom(markSel)));
    dock.append(h('div', { class: 'dbtns' },
      h('button', { class: 'btn ghost', onclick: cancelMark }, 'Cancel'),
      h('button', { class: 'btn accent', disabled: !markSel || busy ? '' : null, onclick: doneMark }, busy ? 'Checking…' : 'Done')));
  } else {
    dock.append(h('div', { class: 'dbtns' },
      h('button', { class: 'btn accent', onclick: startMark }, 'Mark word'),
      h('button', { class: 'btn ghost', disabled: S.placed ? null : '', onclick: () => { if (!S.placed) return toast('Place a letter before ending your turn', 'err'); nextTurn(); } }, 'End turn')));
  }
}

/* ---- bot ---- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEVELS = {            // min/max word length, how many top placements to pick from, words marked per turn
  easy:   { min: 3, max: 4,  pool: 999, words: 1, rank: 1500 },
  medium: { min: 3, max: 6,  pool: 6,   words: 2, rank: 5000 },
  hard:   { min: 2, max: 99, pool: 1,   words: 99, rank: Infinity },
};
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Try every empty box next to a letter with every A–Z; collect unclaimed dictionary words
// (left→right / top→bottom substrings) that run through the new letter.
function botFindMove() {
  const lv = LEVELS[S.level] || LEVELS.medium, used = new Set(S.words), cells = S.cells;
  const known = (w) => {                       // real word, and common enough for this level
    w = w.toLowerCase();
    if (!dict.has(w)) return false;
    if (!common || lv.rank === Infinity) return true;
    const r = common.get(w);
    return r !== undefined && r < lv.rank;
  };
  const empties = new Set(), found = [];
  for (const key of Object.keys(cells)) {
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!cells[k(x + dx, y + dy)]) empties.add(k(x + dx, y + dy));
  }
  for (const ek of empties) {
    const [ex, ey] = ek.split(',').map(Number);
    for (const L of LETTERS) {
      const get = (x, y) => (x === ex && y === ey ? L : (cells[k(x, y)] || {}).c);
      const words = new Map();
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        let sx = ex, sy = ey;
        while (get(sx - dx, sy - dy)) { sx -= dx; sy -= dy; }
        let run = '', ei = 0, x = sx, y = sy;
        while (get(x, y)) { if (x === ex && y === ey) ei = run.length; run += get(x, y); x += dx; y += dy; }
        if (run.length < 2) continue;
        for (let i = 0; i <= ei; i++) for (let j = Math.max(ei, i + lv.min - 1); j < run.length && j - i + 1 <= lv.max; j++) {
          const w = run.slice(i, j + 1);
          if (!used.has(w) && !words.has(w) && known(w))
            words.set(w, { w, a: [sx + dx * i, sy + dy * i], b: [sx + dx * j, sy + dy * j] });
        }
      }
      if (words.size) {
        const list = [...words.values()].sort((p, q) => q.w.length - p.w.length || Math.random() - .5);
        found.push({ x: ex, y: ey, L, words: list, total: list.reduce((n, q) => n + q.w.length, 0) });
      }
    }
  }
  if (!found.length) return null;
  found.sort((p, q) => q.total - p.total || Math.random() - .5);
  const pick = found[Math.floor(Math.random() * Math.min(lv.pool, found.length))];
  pick.words = pick.words.slice(0, lv.words);
  return pick;
}
function panIntoView(x, y) {
  const v = S.view, sx = v.x + x * v.size, sy = v.y + y * v.size, m = v.size * 1.5;
  if (sx > m && sx < board.clientWidth - m && sy > m + 40 && sy < board.clientHeight - dock.offsetHeight - m) return;
  v.x = board.clientWidth / 2 - (x + .5) * v.size; v.y = (board.clientHeight - 120) / 2 - (y + .5) * v.size;
  world.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)'; applyView();
  setTimeout(() => (world.style.transition = ''), 550); save();
}
let botRunning = false;
async function botTurn() {
  if (botRunning) return;
  botRunning = true;
  const turn = S.turnNo, alive = () => S.phase === 'play' && S.turnNo === turn && isBot();
  const end = (msg) => { botRunning = false; if (msg) toast(msg); if (alive()) nextTurn(true); };
  try {
    await sleep(900); if (!alive()) return end();
    if (S.placed) return end();                       // resumed mid-turn after a reload
    if (!dict) await loadDict();
    if (!common) await loadCommon();
    if (!alive()) return end();
    if (!dict) { toast('Bot needs the dictionary to play. Passing', 'err'); await sleep(1500); return end(); }
    const mv = Object.keys(S.cells).length ? botFindMove() : { x: 0, y: 0, L: 'AEIORSTN'[Math.floor(Math.random() * 8)], words: [] };
    if (!mv) { await sleep(500); return end(`${cur().name} couldn't find a word and passed`); }
    panIntoView(mv.x, mv.y);
    await sleep(500); if (!alive()) return end();
    const key = k(mv.x, mv.y);
    S.cells[key] = { c: mv.L, p: S.cur }; S.placed = key; save(); renderBoard();
    for (const q of mv.words) {
      await sleep(900); if (!alive()) return end();
      markSel = { a: q.a, b: q.b }; renderBoard();
      await sleep(1000); if (!alive()) return end();
      claim(q.w, q.a, q.b);
    }
    await sleep(1100);
    end();
  } catch (e) { end(); }
}

/* ---- turn timer ---- */
function tick() {
  if (S.phase !== 'play' || !S.turnEnd) return;
  const left = Math.ceil((S.turnEnd - Date.now()) / 1000);
  if (left <= 0) {
    if (!S.placed) {
      const p = cur(); p.score -= 1;
      toast(`Time's up! ${p.name} placed no letter · −1 point`, 'err');
    } else toast(`Time's up! ${cur().name}'s turn ended`, 'err');
    return nextTurn(true);
  }
  const t = $('#timer');
  if (t) { t.textContent = left + 's'; t.classList.toggle('low', left <= 5); }
}
setInterval(tick, 250);

/* ---- menu ---- */
$('#menu').onclick = () => {
  const box = $('#wordsList'); box.innerHTML = '';
  if (!S.marks.length) box.append(h('em', {}, 'No words yet.'));
  S.marks.forEach((m) => box.append(h('span', { style: `--c:${S.players[m.p].color}`, title: S.players[m.p].name }, m.word)));
  $('#sheet').hidden = false;
};
const closeSheet = () => ($('#sheet').hidden = true);
$('#sheetClose').onclick = closeSheet;
document.querySelector('.sheet-bg').onclick = closeSheet;
$('#newGame').onclick = () => {
  if (!confirm('Start a new game? Current progress will be lost.')) return;
  const setup = S.setup; S = fresh(); S.setup = setup;
  sel = null; markMode = false; markSel = null; lastScores = [];
  tiles.forEach((t) => t.remove()); tiles.clear(); markEls.forEach((m) => m.remove()); markEls.length = 0;
  world.innerHTML = ''; cursorEl = previewEl = null;
  closeSheet(); save(); show();
};

window.addEventListener('resize', () => { if (S.phase === 'play') renderBoard(); });
show();
