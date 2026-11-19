import * as pdfjsLib from './lib/pdf.min.js';

const LIB = new URL('./lib/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.js';

const DOC_OPTS = {
  cMapUrl: LIB + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: LIB + 'standard_fonts/',
  wasmUrl: LIB + 'wasm/',
  iccUrl: LIB + 'iccs/',
};

const $ = (id) => document.getElementById(id);
const els = {
  library: $('library'), books: $('books'), empty: $('empty'), file: $('file'),
  reader: $('reader'), stage: $('stage'), loading: $('loading'),
  back: $('back'), title: $('title'), slider: $('slider'),
  counter: $('counter'), fit: $('fit'), theme: $('theme'),
};

/* ---------- Preferências ---------- */

const prefs = {
  get(key, fallback) {
    try { return localStorage.getItem('folha.' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('folha.' + key, value); } catch { /* sem armazenamento */ }
  },
};

const THEMES = ['claro', 'sepia', 'escuro'];
const THEME_LABEL = { claro: 'Claro', sepia: 'Sépia', escuro: 'Escuro' };
const THEME_COLOR = { claro: '#ffffff', sepia: '#f4ecd8', escuro: '#1a1a1a' };
let theme = prefs.get('theme', 'claro');
let fit = prefs.get('fit', 'pagina');

function applyTheme() {
  document.body.dataset.theme = theme;
  els.theme.textContent = 'Tema: ' + THEME_LABEL[theme];
  const meta = document.querySelector('meta[name="theme-color"]');
  meta.content = els.reader.hidden ? '#f7f4ee' : THEME_COLOR[theme];
}

function applyFit() {
  els.reader.classList.toggle('fit-width', fit === 'largura');
  els.fit.textContent = fit === 'largura' ? 'Ajuste: largura' : 'Ajuste: página';
}

/* ---------- Banco local (IndexedDB) ---------- */

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('folha', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' });
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const store = {
  allMeta: () => run('meta', 'readonly', (s) => s.getAll()),
  getMeta: (id) => run('meta', 'readonly', (s) => s.get(id)),
  putMeta: (m) => run('meta', 'readwrite', (s) => s.put(m)),
  getFile: (id) => run('files', 'readonly', (s) => s.get(id)),
  putFile: (id, buf) => run('files', 'readwrite', (s) => s.put(buf, id)),
  async remove(id) {
    await run('meta', 'readwrite', (s) => s.delete(id));
    await run('files', 'readwrite', (s) => s.delete(id));
  },
};

/* ---------- Estante ---------- */

async function renderLibrary() {
  const list = (await store.allMeta()).sort((a, b) => b.updated - a.updated);
  els.empty.hidden = list.length > 0;
  els.books.replaceChildren(...list.map(bookItem));
}

function bookItem(book) {
  const li = document.createElement('li');
  li.className = 'book';

  const spine = document.createElement('div');
  spine.className = 'book-spine';

  const info = document.createElement('div');
  info.className = 'book-info';

  const name = document.createElement('p');
  name.className = 'book-name';
  name.textContent = book.name;

  const meta = document.createElement('p');
  meta.className = 'book-meta';
  meta.textContent = book.pages
    ? `Página ${book.page} de ${book.pages}`
    : 'Ainda não aberto';

  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('i');
  fill.style.width = book.pages ? `${Math.round((book.page / book.pages) * 100)}%` : '0%';
  bar.append(fill);

  info.append(name, meta, bar);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'book-del';
  del.textContent = 'Remover';
  let armed = null;
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      del.classList.add('confirm');
      del.textContent = 'Confirmar';
      armed = setTimeout(() => {
        armed = null;
        del.classList.remove('confirm');
        del.textContent = 'Remover';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    await store.remove(book.id);
    renderLibrary();
  });

  li.append(spine, info, del);
  li.addEventListener('click', () => openBook(book.id));
  return li;
}

els.file.addEventListener('change', async () => {
  const file = els.file.files[0];
  els.file.value = '';
  if (!file) return;

  navigator.storage?.persist?.().catch(() => {});

  const name = file.name.replace(/\.pdf$/i, '');
  const existing = (await store.allMeta()).find((b) => b.name === name && b.size === file.size);
  if (existing) return openBook(existing.id);

  const id = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2));
  const buf = await file.arrayBuffer();
  await store.putFile(id, buf);
  await store.putMeta({ id, name, size: file.size, pages: 0, page: 1, updated: Date.now() });
  openBook(id, true);
});

/* ---------- Leitura ---------- */

let doc = null;
let task = null;
let book = null;
let pageNum = 1;
let token = 0;
let current = null;
const cache = new Map();      // páginas já desenhadas
const crops = new Map();      // área útil de cada página

async function openBook(id, isNew = false) {
  book = await store.getMeta(id);
  const buf = await store.getFile(id);
  if (!book || !buf) return renderLibrary();

  els.library.hidden = true;
  els.reader.hidden = false;
  els.reader.classList.remove('ui');
  els.loading.hidden = false;
  els.title.textContent = book.name;
  applyTheme();
  if (history.state?.folha !== 'reader') history.pushState({ folha: 'reader' }, '');

  try {
    task = pdfjsLib.getDocument({ data: new Uint8Array(buf), ...DOC_OPTS });
    doc = await task.promise;
  } catch (err) {
    console.error(err);
    if (isNew) await store.remove(id);
    alert('Não consegui abrir esse arquivo. Confere se ele é um PDF válido.');
    return closeReader();
  }

  book.pages = doc.numPages;
  els.slider.max = doc.numPages;
  crops.clear();
  clearCache();
  goTo(Math.min(Math.max(1, book.page || 1), doc.numPages));
}

async function closeReader() {
  token++;
  saveProgress(true);
  clearCache();
  els.stage.replaceChildren();
  current = null;
  doc = null;
  if (task) { task.destroy().catch(() => {}); task = null; }
  book = null;
  els.reader.hidden = true;
  els.library.hidden = false;
  applyTheme();
  renderLibrary();
}

function available() {
  const s = getComputedStyle(els.stage);
  return {
    w: els.stage.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
    h: els.stage.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom),
  };
}

function layoutKey() {
  const { w, h } = available();
  return `${fit}|${Math.round(w)}x${Math.round(h)}|${window.devicePixelRatio || 1}`;
}

// Descobre onde está o conteúdo da página pra cortar as margens em branco.
async function getCrop(page) {
  if (crops.has(page.pageNumber)) return crops.get(page.pageNumber);

  const base = page.getViewport({ scale: 1 });
  const s = 500 / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale: s });
  const c = document.createElement('canvas');
  const w = (c.width = Math.ceil(vp.width));
  const h = (c.height = Math.ceil(vp.height));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  const px = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;

  // cor de fundo = cor mais comum na borda da página
  const buckets = new Map();
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  };
  for (let x = 0; x < w; x += 2) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += 2) { sample(0, y); sample(w - 1, y); }
  let bg = 0xfff, best = -1;
  for (const [k, n] of buckets) if (n > best) { best = n; bg = k; }
  const br = ((bg >> 8) & 15) * 16 + 8;
  const bgG = ((bg >> 4) & 15) * 16 + 8;
  const bb = (bg & 15) * 16 + 8;

  const rows = new Uint16Array(h);
  const cols = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(px[i] - br), Math.abs(px[i + 1] - bgG), Math.abs(px[i + 2] - bb));
      if (d > 48) { rows[y]++; cols[x]++; }
    }
  }

  const first = (arr) => arr.findIndex((n) => n >= 2);
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const y0 = first(rows), y1 = last(rows), x0 = first(cols), x1 = last(cols);

  let crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (y0 >= 0 && x0 >= 0) {
    const pad = Math.round(Math.max(w, h) * 0.015);
    crop = {
      x0: Math.max(0, x0 - pad) / w,
      y0: Math.max(0, y0 - pad) / h,
      x1: Math.min(w, x1 + 1 + pad) / w,
      y1: Math.min(h, y1 + 1 + pad) / h,
    };
  }
  crops.set(page.pageNumber, crop);
  return crop;
}

function renderPage(n) {
  const key = `${n}|${layoutKey()}`;
  if (cache.has(key)) return cache.get(key);
  const pdf = doc;

  const job = (async () => {
    const page = await pdf.getPage(n);
    const crop = await getCrop(page);
    const base = page.getViewport({ scale: 1 });
    const cw = (crop.x1 - crop.x0) * base.width;
    const ch = (crop.y1 - crop.y0) * base.height;
    const { w, h } = available();
    const scale = fit === 'largura' ? w / cw : Math.min(w / cw, h / ch);

    let dpr = window.devicePixelRatio || 1;
    const maxPixels = 14e6;
    if (cw * ch * scale * scale * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (cw * ch * scale * scale));
    const rs = scale * dpr;

    const vp = page.getViewport({
      scale: rs,
      offsetX: -crop.x0 * base.width * rs,
      offsetY: -crop.y0 * base.height * rs,
    });
    const c = document.createElement('canvas');
    c.width = Math.round(cw * rs);
    c.height = Math.round(ch * rs);
    c.style.width = `${Math.round(cw * scale)}px`;
    c.style.height = `${Math.round(ch * scale)}px`;
    await page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise;
    return c;
  })();

  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

function release(job) {
  job.then((c) => { if (c !== current) c.width = c.height = 0; }).catch(() => {});
}

function clearCache() {
  for (const job of cache.values()) release(job);
  cache.clear();
}

function trimCache() {
  const lk = layoutKey();
  for (const [key, job] of cache) {
    const [n, ...rest] = key.split('|');
    if (rest.join('|') !== lk || Math.abs(Number(n) - pageNum) > 2) {
      cache.delete(key);
      release(job);
    }
  }
}

async function goTo(n) {
  if (!doc) return;
  n = Math.min(Math.max(1, n), doc.numPages);
  pageNum = n;
  const mine = ++token;
  updateBar();

  const slow = setTimeout(() => { if (mine === token) els.loading.hidden = false; }, 120);
  try {
    const c = await renderPage(n);
    if (mine !== token) return;
    current = c;
    els.stage.replaceChildren(c);
    els.stage.scrollTop = 0;
  } catch (err) {
    if (mine === token) console.error(err);
  } finally {
    clearTimeout(slow);
    if (mine === token) els.loading.hidden = true;
  }
  if (mine !== token) return;

  saveProgress();
  trimCache();
  // deixa a próxima (e a anterior) prontas
  setTimeout(() => {
    if (mine !== token || !doc) return;
    if (n < doc.numPages) renderPage(n + 1).catch(() => {});
    if (n > 1) renderPage(n - 1).catch(() => {});
  }, 60);
}

function next() { if (doc && pageNum < doc.numPages) { setUI(false); goTo(pageNum + 1); } }
function prev() { if (doc && pageNum > 1) { setUI(false); goTo(pageNum - 1); } }

let saveTimer = null;
function saveProgress(now = false) {
  if (!book) return;
  book.page = pageNum;
  book.updated = Date.now();
  const snapshot = { ...book };
  clearTimeout(saveTimer);
  const write = () => store.putMeta(snapshot).catch(() => {});
  if (now) write(); else saveTimer = setTimeout(write, 400);
}

function updateBar() {
  els.slider.value = pageNum;
  els.counter.textContent = `${pageNum} de ${doc?.numPages ?? '–'}`;
}

function setUI(show) {
  els.reader.classList.toggle('ui', show);
}

/* ---------- Toques, gestos e teclado ---------- */

let touch = null;
let swipedAt = 0;

els.stage.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touch = null; return; }
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

els.stage.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    swipedAt = Date.now();
    if (dx < 0) next(); else prev();
  }
}, { passive: true });

els.stage.addEventListener('click', (e) => {
  if (Date.now() - swipedAt < 400) return;
  const x = e.clientX / window.innerWidth;
  if (x < 0.3) prev();
  else if (x > 0.7) next();
  else setUI(!els.reader.classList.contains('ui'));
});

document.addEventListener('keydown', (e) => {
  if (els.reader.hidden || e.target === els.slider) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === 'Escape') leave();
});

els.slider.addEventListener('input', () => {
  els.counter.textContent = `${els.slider.value} de ${doc?.numPages ?? '–'}`;
});
els.slider.addEventListener('change', () => goTo(Number(els.slider.value)));

els.fit.addEventListener('click', () => {
  fit = fit === 'largura' ? 'pagina' : 'largura';
  prefs.set('fit', fit);
  applyFit();
  clearCache();
  goTo(pageNum);
});

els.theme.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  prefs.set('theme', theme);
  applyTheme();
});

function leave() {
  if (history.state?.folha === 'reader') history.back();
  else closeReader();
}
els.back.addEventListener('click', leave);

window.addEventListener('popstate', () => {
  if (!els.reader.hidden) closeReader();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (els.reader.hidden || !doc) return;
    clearCache();
    goTo(pageNum);
  }, 150);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(true);
});

/* ---------- Início ---------- */

if (!THEMES.includes(theme)) theme = 'claro';
if (fit !== 'largura') fit = 'pagina';
applyTheme();
applyFit();
if (history.state?.folha === 'reader') history.replaceState(null, '');
renderLibrary();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
