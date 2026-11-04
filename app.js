'use strict';
/* Wordgrid — static, no build. State lives in localStorage. */

const KEY = 'wordgrid.v1';
const PALETTE = ['#ef6a5b', '#4c8df6', '#3cb97a', '#f2a93b', '#9b6bdc', '#e8588f', '#2bb5c4', '#8a9a3b'];
const DICT_URL = 'https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt';
const API_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MIN_LEN = 2;

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
    setup: { n: 2, players: PALETTE.map((c, i) => ({ name: 'User' + (i + 1), color: c })) },
    players: [], cur: 0,
    cells: {},        // "x,y" -> {c:'A', p:playerIndex}
    marks: [],        // {a:[x,y], b:[x,y], p, word}
    words: [],        // claimed words (uppercase)
    placed: null,     // key of the letter placed this turn
    view: { x: null, y: null, size: 56 },
    detail: false,
  };
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.phase) return Object.assign(fresh(), s); } catch (e) { }
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
let toastT;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function setTint() { document.documentElement.style.setProperty('--pc', S.phase === 'play' && cur() ? cur().color : '#999999'); }

/* ================= SETUP ================= */
function renderSetup() {
  $('#count').textContent = S.setup.n;
  const list = $('#plist'); list.innerHTML = '';
  for (let i = 0; i < S.setup.n; i++) {
    const p = S.setup.players[i];
    const row = h('div', { class: 'prow', style: `--c:${p.color};animation-delay:${i * 40}ms` });
    const inp = h('input', { type: 'text', value: p.name, maxlength: 16, placeholder: 'User' + (i + 1), 'aria-label': 'Player ' + (i + 1) + ' name' });
    inp.addEventListener('input', () => { p.name = inp.value; save(); });
    const col = h('input', { type: 'color', value: p.color, 'aria-label': 'Player ' + (i + 1) + ' color' });
    col.addEventListener('input', () => { p.color = col.value; row.style.setProperty('--c', col.value); save(); });
    row.append(inp, h('label', { class: 'swatch' }, h('i'), col));
    list.append(row);
  }
}
$('#plus').onclick = () => { if (S.setup.n < 8) { S.setup.n++; save(); renderSetup(); } };
$('#minus').onclick = () => { if (S.setup.n > 2) { S.setup.n--; save(); renderSetup(); } };
$('#start').onclick = () => {
  S.players = S.setup.players.slice(0, S.setup.n).map((p, i) => ({ name: p.name.trim() || 'User' + (i + 1), color: p.color, score: 0 }));
  Object.assign(S, { phase: 'play', cur: 0, cells: {}, marks: [], words: [], placed: null, view: { x: null, y: null, size: window.innerWidth < 520 ? 48 : 56 } });
  sel = null; markMode = false; markSel = null;
  save(); show();
};

/* ================= GAME ================= */
const board = $('#board'), world = $('#world'), dock = $('#dock');
const tiles = new Map(), markEls = [];
let cursorEl = null, previewEl = null;

function show() {
  $('#setup').hidden = S.phase !== 'setup';
  $('#game').hidden = S.phase !== 'play';
  setTint();
  if (S.phase === 'setup') renderSetup();
  else { loadDict(); initView(); renderAll(); }
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
    el.classList.toggle('mine', key === S.placed);
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
  if (markMode && markSel) {
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
  const onLetter = !!S.cells[k(c[0], c[1])];
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
    const b = Math.abs(ddx) >= Math.abs(ddy) ? [c[0], a[1]] : [a[0], c[1]]; // lock to a straight line
    if (!markSel || markSel.b[0] !== b[0] || markSel.b[1] !== b[1]) { markSel = { a, b }; renderBoard(); renderDock(); }
  }
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null; board.classList.remove('dragging');
  if (d.mode === 'pan') {
    if (d.moved) save(); else tapCell(d.c);
  }
};
board.addEventListener('pointerup', endDrag);
board.addEventListener('pointercancel', endDrag);
board.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY); }, { passive: false });

function tapCell([x, y]) {
  if (markMode) return;
  const key = k(x, y), cell = S.cells[key];
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
  if (!sel) return;
  const key = k(sel.x, sel.y), ex = S.cells[key];
  if (ex && key !== S.placed) return toast('That box is taken', 'err');
  if (S.placed && S.placed !== key) delete S.cells[S.placed]; // one letter per turn: moving it
  S.cells[key] = { c: ch.toUpperCase(), p: S.cur };
  S.placed = key; sel = null;
  if (tiles.has(key)) { const t = tiles.get(key); t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; }
  save(); renderBoard(); renderDock();
}
function removeLetter() {
  if (!S.placed) return;
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
  if (S.phase !== 'play' || e.ctrlKey || e.metaKey || e.altKey || !$('#sheet').hidden) return;
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

function startMark() { markMode = true; markSel = null; sel = null; renderBoard(); renderDock(); }
function cancelMark() { markMode = false; markSel = null; busy = false; renderBoard(); renderDock(); }
function fail(msg) {
  toast(msg, 'err');
  if (previewEl) { previewEl.classList.remove('shake'); void previewEl.offsetWidth; previewEl.classList.add('shake'); }
}
async function doneMark() {
  if (busy || !markSel) return;
  const w = wordFrom(markSel);
  if (w.includes('?')) return fail('Every box in the line needs a letter');
  if (w.length < MIN_LEN) return fail(`Select at least ${MIN_LEN} letters`);
  if (S.words.includes(w)) return fail(`"${w}" has already been taken`);
  busy = true; renderDock();
  let ok;
  try { ok = await isWord(w); }
  catch (e) { busy = false; renderDock(); return fail('Could not reach the dictionary'); }
  busy = false;
  if (!ok) { renderDock(); return fail(`"${w}" is not a valid word`); }
  const p = cur(), m = { a: markSel.a, b: markSel.b, p: S.cur, word: w };
  S.words.push(w); S.marks.push(m); p.score += w.length;
  floatText('+' + w.length, m.b[0], m.b[1], p.color);
  toast(`${p.name} claimed ${w} (+${w.length})`, 'ok');
  nextTurn(true);
}
function nextTurn(silent) {
  S.cur = (S.cur + 1) % S.players.length;
  S.placed = null; sel = null; markMode = false; markSel = null; busy = false;
  save(); renderAll();
  if (!silent) toast(`${cur().name}'s turn`);
}

/* ---- dock ---- */
function renderDock() {
  const p = cur(); dock.innerHTML = '';
  const hint = sel ? 'Pick a letter for this box'
    : markMode ? 'Drag from the first to the last letter'
    : S.placed ? 'Letter placed · mark a word or end turn' : 'Tap an empty box to place a letter';
  dock.append(h('div', { class: 'dtop' }, h('span', { class: 'dot' }),
    h('div', { class: 'grow' }, h('b', {}, `${p.name}'s turn`), h('small', {}, hint))));

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
      h('button', { class: 'btn ghost', onclick: () => nextTurn() }, 'End turn')));
  }
}

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
