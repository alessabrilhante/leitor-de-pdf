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
  modeSeg: $('modeSeg'), fontCtl: $('fontCtl'), fontDown: $('fontDown'),
  fontUp: $('fontUp'), fontSize: $('fontSize'), toast: $('toast'),
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

const THEMES = ['claro', 'sepia', 'rosa', 'escuro'];
const THEME_LABEL = { claro: 'Claro', sepia: 'Sépia', rosa: 'Rosa', escuro: 'Escuro' };
const THEME_COLOR = { claro: '#ffffff', sepia: '#f4ecd8', rosa: '#fffafc', escuro: '#1a1a1a' };
const SHELL_COLOR = { rosa: '#fff2f7' };
const FONT_MIN = 14, FONT_MAX = 40, FONT_PADRAO = 20;
let theme = prefs.get('theme', 'claro');
let fit = prefs.get('fit', 'pagina');
let mode = prefs.get('mode', 'texto');               // 'texto' (letra ajustável) ou 'pagina' (PDF original)
let fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(prefs.get('fonte', FONT_PADRAO)) || FONT_PADRAO));

function applyTheme() {
  document.body.dataset.theme = theme;
  els.theme.textContent = 'Tema: ' + THEME_LABEL[theme];
  const meta = document.querySelector('meta[name="theme-color"]');
  meta.content = els.reader.hidden ? (SHELL_COLOR[theme] || '#f7f4ee') : THEME_COLOR[theme];
}

// Modo do livro aberto: PDF escaneado (sem texto) só abre como página
const textMode = () => mode === 'texto' && !book?.semTexto;

function applyMode() {
  const t = textMode();
  els.reader.classList.toggle('mode-texto', t);
  els.reader.classList.toggle('fit-width', !t && fit === 'largura');
  for (const b of els.modeSeg.querySelectorAll('button')) b.classList.toggle('on', (b.dataset.mode === 'texto') === t);
  els.fontCtl.hidden = !t;
  els.fit.hidden = t;
  els.fontSize.textContent = fontSize;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function applyFit() {
  els.reader.classList.toggle('fit-width', !textMode() && fit === 'largura');
  els.fit.textContent = fit === 'largura' ? 'Ajuste: largura' : 'Ajuste: página';
}

/* ---------- Banco local (IndexedDB) ---------- */

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('folha', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('dias')) d.createObjectStore('dias', { keyPath: 'date' });
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
  allDays: () => run('dias', 'readonly', (s) => s.getAll()),
  getDay: (date) => run('dias', 'readonly', (s) => s.get(date)),
  putDay: (d) => run('dias', 'readwrite', (s) => s.put(d)),
  async remove(id) {
    await run('meta', 'readwrite', (s) => s.delete(id));
    await run('files', 'readwrite', (s) => s.delete(id));
  },
};

/* ---------- Registro de leitura: tempo e páginas, por dia e por livro ---------- */

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PARADA_MAX = 3 * 60 * 1000;   // mais que isso sem tocar na tela não conta como leitura
let lastActive = 0;
let pend = { ms: 0, pages: 0 };      // ainda não gravado
let flushTimer = null;

function activity() {
  if (!book) return;
  const now = Date.now();
  if (lastActive) pend.ms += Math.min(now - lastActive, PARADA_MAX);
  lastActive = now;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLog, 4000);
}

function countPage() {
  if (!book) return;
  pend.pages++;
  activity();
}

async function flushLog() {
  clearTimeout(flushTimer);
  if (!book || (!pend.ms && !pend.pages)) return;
  const { ms, pages } = pend;
  pend = { ms: 0, pages: 0 };
  const key = dayKey();
  const day = (await store.getDay(key)) || { date: key, ms: 0, pages: 0, books: {} };
  day.ms += ms;
  day.pages += pages;
  const b = day.books[book.id] || { ms: 0, pages: 0 };
  b.ms += ms;
  b.pages += pages;
  b.name = book.name;
  day.books[book.id] = b;
  await store.putDay(day);
  book.ms = (book.ms || 0) + ms;
  book.read = (book.read || 0) + pages;
  saveProgress(true);
}

/* ---------- Capa e autor de cada livro ---------- */

// "Girl Boss - Sophia Amoruso" com autor conhecido vira só "Girl Boss"
function titulo(b) {
  const n = cleanName(b.name);
  if (b.author) {
    const i = n.toLowerCase().lastIndexOf(' - ');
    if (i > 0 && norm(n.slice(i + 3)).includes(norm(b.author).split(' ')[0])) return n.slice(0, i);
  }
  return n;
}
const tituloCurto = (nome) => cleanName(nome).split(' - ')[0];

const isOpened = (b) => b.opened === true || (b.opened === undefined && b.pages > 0);

async function makeCover(pdf) {
  let best = null, bestInk = -1;
  for (let n = 1; n <= Math.min(3, pdf.numPages); n++) {
    const page = await pdf.getPage(n);
    const v = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 320 / v.width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0, total = 0;
    for (let i = 0; i < px.length; i += 4 * 9) { total++; if (px[i] + px[i + 1] + px[i + 2] < 690) ink++; }
    const ratio = ink / total;
    // a capa costuma ser a página mais "cheia" do começo (pula página em branco)
    if (ratio > bestInk) { bestInk = ratio; best = c.toDataURL('image/jpeg', 0.8); }
    c.width = c.height = 0;
    if (ratio > 0.35) break;
  }
  return best;
}

const enriching = new Set();
async function enrich(b) {
  if (b.enriched || enriching.has(b.id)) return false;
  enriching.add(b.id);
  let t = null;
  try {
    const buf = await store.getFile(b.id);
    if (!buf) return false;
    t = pdfjsLib.getDocument({ data: new Uint8Array(buf), ...DOC_OPTS });
    const pdf = await t.promise;
    let author = '';
    try {
      const m = await pdf.getMetadata();
      author = String(m?.info?.Author || '').trim();
    } catch { /* sem metadados */ }
    const cover = await makeCover(pdf).catch(() => null);
    const fresh = await store.getMeta(b.id);
    if (!fresh) return false;
    if (fresh.opened === undefined) fresh.opened = fresh.pages > 0;
    fresh.pages = fresh.pages || pdf.numPages;
    if (cover) fresh.cover = cover;
    if (author && author.length < 80 && !/^(user|usuario|usuário|admin|unknown|microsoft|adobe)/i.test(author)) fresh.author = author;
    fresh.enriched = true;
    await store.putMeta(fresh);
    return true;
  } catch (err) {
    console.warn(err);
    const fresh = await store.getMeta(b.id);
    if (fresh) { fresh.enriched = true; await store.putMeta(fresh); }
    return false;
  } finally {
    enriching.delete(b.id);
    t?.destroy().catch(() => {});
  }
}

let enrichRunning = false;
async function enrichAll() {
  if (enrichRunning) return;
  enrichRunning = true;
  try {
    let changed = false;
    for (const b of await store.allMeta()) {
      if (!els.reader.hidden) break;          // não pesa enquanto você lê
      if (!b.enriched && await enrich(b)) changed = true;
    }
    if (changed && els.reader.hidden) renderView(false);
  } finally {
    enrichRunning = false;
  }
}

/* ---------- Formatação ---------- */

function fmtTempo(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function coverEl(b, cls = 'capa') {
  const box = el('div', cls);
  if (b.cover) {
    const img = new Image();
    img.src = b.cover;
    img.alt = '';
    box.append(img);
  } else {
    box.classList.add('capa-vazia');
    box.append(el('span', '', cleanName(b.name)));
  }
  if (!isOpened(b)) box.append(el('span', 'novo', 'Novo'));
  return box;
}

function streak(days) {
  const ok = (d) => d && (d.pages > 0 || d.ms >= 60000);
  const map = new Map(days.map((d) => [d.date, d]));
  const d = new Date();
  if (!ok(map.get(dayKey(d)))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (ok(map.get(dayKey(d)))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function soma(days, from, to) {
  let ms = 0, pages = 0;
  for (const d of days) if (d.date >= from && d.date <= to) { ms += d.ms; pages += d.pages; }
  return { ms, pages };
}

function inicioDaSemana(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // segunda-feira
  return x;
}

const metaDia = () => Math.max(1, Number(prefs.get('metaDia', 30)) || 30);
const metaMes = () => Math.max(1, Number(prefs.get('metaMes', 900)) || 900);

/* ---------- Telas: Início, Biblioteca, Estatísticas ---------- */

let view = 'inicio';
let filtro = 'Todos';
let vis = prefs.get('vis', 'grade');

function showView(v) {
  if (v === 'buscar') {
    showView('biblioteca');
    setTimeout(() => $('busca').focus(), 50);
    return;
  }
  view = v;
  for (const id of ['inicio', 'biblioteca', 'estatisticas']) $('view-' + id).hidden = id !== v;
  for (const b of document.querySelectorAll('.nav button')) b.classList.toggle('on', b.dataset.view === v);
  window.scrollTo(0, 0);
  renderView();
}

function renderView(enrichNow = true) {
  const job = view === 'inicio' ? renderInicio() : view === 'biblioteca' ? renderBiblioteca() : renderStats();
  if (enrichNow) job.then(() => setTimeout(enrichAll, 300));
  return job;
}
const renderLibrary = () => renderView();

async function renderInicio() {
  const [books, days] = await Promise.all([store.allMeta(), store.allDays()]);
  const hoje = new Date();
  const data = hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('hoje-data').textContent = data.charAt(0).toUpperCase() + data.slice(1);

  const abertos = books.filter(isOpened).sort((a, b) => b.updated - a.updated);
  const atual = abertos[0];
  $('inicio-vazio').hidden = books.length > 0;
  $('atual').hidden = !atual;
  if (atual) {
    $('atual-capa').replaceWith(Object.assign(coverEl(atual, 'capa capa-g'), { id: 'atual-capa' }));
    $('atual-nome').textContent = titulo(atual);
    $('atual-autor').textContent = atual.author || '';
    const p = pct(atual.page, atual.pages);
    $('atual-barra').style.width = `${p}%`;
    $('atual-meta').textContent = `Pág. ${atual.page} de ${atual.pages} · ${p}%`;
    $('atual-continuar').onclick = () => openBook(atual.id);
    $('atual-capa').onclick = () => openBook(atual.id);
  }

  const d = days.find((x) => x.date === dayKey()) || { ms: 0, pages: 0 };
  $('n-paginas').textContent = d.pages;
  $('n-tempo').textContent = fmtTempo(d.ms);
  $('n-seq').textContent = `🔥 ${streak(days)}`;

  const mes = soma(days, dayKey(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), dayKey(hoje));
  setMeta($('meta-dia'), d.pages, metaDia());
  setMeta($('meta-mes'), mes.pages, metaMes());

  const resto = books.filter((b) => b !== atual).sort((a, b) => b.updated - a.updated).slice(0, 12);
  $('recentes-box').hidden = !resto.length;
  $('recentes').replaceChildren(...resto.map((b) => {
    const btn = el('button', 'recente');
    btn.type = 'button';
    btn.append(coverEl(b), el('span', 'recente-nome', titulo(b)));
    btn.onclick = () => openBook(b.id);
    return btn;
  }));
}

function setMeta(btn, feito, meta) {
  btn.querySelector('i').style.width = `${pct(feito, meta)}%`;
  btn.querySelector('.meta-num').textContent = `${feito} / ${meta} págs. (${pct(feito, meta)}%)`;
}

$('meta-dia').onclick = () => editarMeta('metaDia', 'Meta do dia', metaDia(), 5);
$('meta-mes').onclick = () => editarMeta('metaMes', 'Meta do mês', metaMes(), 50);

function editarMeta(chave, titulo, valor, passo) {
  const body = el('div', 'meta-edit');
  const num = el('input', 'meta-input');
  num.type = 'number';
  num.inputMode = 'numeric';
  num.value = valor;
  const menos = el('button', 'btn-redondo', '−');
  const mais = el('button', 'btn-redondo', '+');
  menos.type = mais.type = 'button';
  menos.onclick = () => { num.value = Math.max(passo, (Number(num.value) || 0) - passo); };
  mais.onclick = () => { num.value = (Number(num.value) || 0) + passo; };
  const linha = el('div', 'meta-linha');
  linha.append(menos, num, mais);
  const salvar = el('button', 'btn-cheio', 'Salvar');
  salvar.type = 'button';
  salvar.onclick = () => {
    const v = Math.max(1, Math.round(Number(num.value) || 0));
    prefs.set(chave, String(v));
    closeSheet();
    renderView(false);
  };
  body.append(el('h3', 'sheet-titulo', titulo), el('p', 'sheet-sub', 'Quantas páginas?'), linha, salvar);
  openSheet(body);
}

async function renderBiblioteca() {
  const books = (await store.allMeta()).sort((a, b) => b.updated - a.updated);
  const tags = [...new Set(books.flatMap((b) => b.tags || []))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (filtro !== 'Todos' && filtro !== 'Novos' && !tags.includes(filtro)) filtro = 'Todos';

  const chips = ['Todos', 'Novos', ...tags].map((t) => {
    const c = el('button', 'chip' + (t === filtro ? ' on' : ''), t);
    c.type = 'button';
    c.onclick = () => { filtro = t; renderBiblioteca(); };
    return c;
  });
  $('filtros').replaceChildren(...chips);
  $('vis').textContent = vis === 'grade' ? 'Ver em lista' : 'Ver em grade';

  const q = norm($('busca').value.trim());
  const lista = books.filter((b) =>
    (filtro === 'Todos' || (filtro === 'Novos' ? !isOpened(b) : (b.tags || []).includes(filtro))) &&
    (!q || norm(cleanName(b.name) + ' ' + (b.author || '')).includes(q)));

  els.books.className = `books ${vis}`;
  els.books.replaceChildren(...lista.map(bookItem));
  els.empty.hidden = lista.length > 0;
  els.empty.textContent = books.length === 0
    ? 'Sua estante está vazia. Adicione PDFs na tela Início.'
    : 'Nenhum livro encontrado.';
}

function bookItem(b) {
  const li = el('li', 'book');
  const abrir = el('button', 'book-abrir');
  abrir.type = 'button';
  const info = el('div', 'book-info');
  info.append(el('p', 'book-name', titulo(b)));
  if (b.author) info.append(el('p', 'book-autor', b.author));
  info.append(el('p', 'book-meta', isOpened(b) ? `Pág. ${b.page} de ${b.pages} · ${pct(b.page, b.pages)}%` : (b.pages ? `${b.pages} páginas` : 'Ainda não aberto')));
  if (isOpened(b)) {
    const bar = el('div', 'barra');
    const i = el('i');
    i.style.width = `${pct(b.page, b.pages)}%`;
    bar.append(i);
    info.append(bar);
  }
  if (b.tags?.length) {
    const t = el('p', 'book-tags');
    for (const tag of b.tags) t.append(el('span', '', tag));
    info.append(t);
  }
  abrir.append(coverEl(b), info);
  abrir.onclick = () => openBook(b.id);

  const mais = el('button', 'book-mais');
  mais.type = 'button';
  mais.setAttribute('aria-label', 'Etiquetas e opções');
  mais.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  mais.onclick = (e) => { e.stopPropagation(); opcoesLivro(b.id); };

  li.append(abrir, mais);
  return li;
}

async function opcoesLivro(id) {
  const b = await store.getMeta(id);
  if (!b) return;
  const all = await store.allMeta();
  const tags = [...new Set([...all.flatMap((x) => x.tags || []), 'Lendo', 'Lido', 'Quero ler'])].sort((a, c) => a.localeCompare(c, 'pt-BR'));
  const minhas = new Set(b.tags || []);

  const body = el('div');
  body.append(el('h3', 'sheet-titulo', titulo(b)), el('p', 'sheet-sub', 'Etiquetas'));
  const box = el('div', 'filtros');
  const salvar = async () => {
    const fresh = await store.getMeta(id);
    if (!fresh) return;
    fresh.tags = [...minhas];
    await store.putMeta(fresh);
    renderView(false);
  };
  const desenhar = () => {
    box.replaceChildren(...tags.map((t) => {
      const c = el('button', 'chip' + (minhas.has(t) ? ' on' : ''), t);
      c.type = 'button';
      c.onclick = () => { minhas.has(t) ? minhas.delete(t) : minhas.add(t); desenhar(); salvar(); };
      return c;
    }));
  };
  desenhar();

  const nova = el('form', 'nova-tag');
  const inp = el('input');
  inp.placeholder = 'Nova etiqueta';
  inp.maxLength = 30;
  const add = el('button', 'btn-leve', 'Criar');
  add.type = 'submit';
  nova.append(inp, add);
  nova.onsubmit = (e) => {
    e.preventDefault();
    const t = inp.value.trim();
    if (!t) return;
    if (!tags.includes(t)) tags.push(t);
    minhas.add(t);
    inp.value = '';
    desenhar();
    salvar();
  };

  const del = el('button', 'btn-perigo', 'Remover da estante');
  del.type = 'button';
  let armado = false;
  del.onclick = async () => {
    if (!armado) { armado = true; del.textContent = 'Toque de novo pra remover'; return; }
    await store.remove(id);
    closeSheet();
    renderView(false);
  };

  body.append(box, nova, del);
  openSheet(body);
}

$('busca').addEventListener('input', () => renderBiblioteca());
$('vis').onclick = () => {
  vis = vis === 'grade' ? 'lista' : 'grade';
  prefs.set('vis', vis);
  renderBiblioteca();
};

/* ---------- Estatísticas ---------- */

let mesVisto = new Date();
mesVisto.setDate(1);

async function renderStats() {
  const [books, days] = await Promise.all([store.allMeta(), store.allDays()]);
  const hoje = new Date();
  const box = $('stats');
  box.replaceChildren();

  const bloco = (titulo, itens) => {
    const s = el('section', 'stat-bloco');
    s.append(el('h3', 'secao', titulo));
    const g = el('div', 'numeros');
    for (const [v, l] of itens) {
      const d = el('div');
      d.append(el('strong', '', v), el('span', '', l));
      g.append(d);
    }
    s.append(g);
    box.append(s);
  };

  const atual = books.filter(isOpened).sort((a, b) => b.updated - a.updated)[0];
  if (atual) {
    const lidas = atual.read || 0;
    bloco(`Livro atual · ${titulo(atual)}`, [
      [fmtTempo(atual.ms), 'Tempo total'],
      [String(lidas), 'Páginas lidas'],
      [lidas ? fmtTempo(atual.ms / lidas) : '–', 'Por página'],
      [`${pct(atual.page, atual.pages)}%`, 'Do livro'],
    ]);
  }

  const seg = inicioDaSemana(hoje);
  const diasSemana = (hoje.getDay() + 6) % 7 + 1;
  const sem = soma(days, dayKey(seg), dayKey(hoje));
  bloco('Esta semana', [
    [String(sem.pages), 'Páginas'],
    [String(Math.round(sem.pages / diasSemana)), 'Páginas/dia'],
    [fmtTempo(sem.ms / diasSemana), 'Tempo/dia'],
    [fmtTempo(sem.ms), 'Tempo total'],
  ]);

  const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const mes = soma(days, dayKey(ini), dayKey(hoje));
  bloco('Este mês', [
    [String(mes.pages), 'Páginas'],
    [String(Math.round(mes.pages / hoje.getDate())), 'Páginas/dia'],
    [fmtTempo(mes.ms / hoje.getDate()), 'Tempo/dia'],
    [fmtTempo(mes.ms), 'Tempo total'],
  ]);

  const meta = el('button', 'meta');
  meta.type = 'button';
  meta.append(el('span', 'meta-nome', 'Meta do mês'), Object.assign(el('span', 'barra'), { innerHTML: '<i></i>' }), el('span', 'meta-num'));
  setMeta(meta, mes.pages, metaMes());
  meta.onclick = () => editarMeta('metaMes', 'Meta do mês', metaMes(), 50);
  const metas = el('section', 'metas');
  metas.append(meta);
  box.append(metas);

  box.append(calendario(days));
}

function calendario(days) {
  const map = new Map(days.map((d) => [d.date, d]));
  const ano = mesVisto.getFullYear(), m = mesVisto.getMonth();
  const s = el('section', 'cal');

  const topo = el('div', 'cal-topo');
  const ant = el('button', 'btn-redondo', '‹');
  const prox = el('button', 'btn-redondo', '›');
  ant.type = prox.type = 'button';
  ant.setAttribute('aria-label', 'Mês anterior');
  prox.setAttribute('aria-label', 'Próximo mês');
  ant.onclick = () => { mesVisto = new Date(ano, m - 1, 1); renderStats(); };
  prox.onclick = () => { mesVisto = new Date(ano, m + 1, 1); renderStats(); };
  const nome = mesVisto.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  topo.append(ant, el('h3', 'cal-mes', nome.charAt(0).toUpperCase() + nome.slice(1)), prox);
  s.append(topo);

  const grade = el('div', 'cal-grade');
  for (const d of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']) grade.append(el('span', 'cal-dow', d));
  const primeiro = new Date(ano, m, 1);
  for (let i = 0; i < (primeiro.getDay() + 6) % 7; i++) grade.append(el('span', 'cal-vazio'));
  const hojeKey = dayKey();
  const ultimo = new Date(ano, m + 1, 0).getDate();
  for (let dia = 1; dia <= ultimo; dia++) {
    const key = dayKey(new Date(ano, m, dia));
    const reg = map.get(key);
    const c = el('div', 'cal-dia' + (key === hojeKey ? ' hoje' : '') + (key > hojeKey ? ' futuro' : '') + (reg && (reg.pages || reg.ms >= 60000) ? ' lido' : ''));
    c.append(el('span', 'cal-n', String(dia)));
    if (reg) {
      const livros = Object.values(reg.books || {}).filter((b) => b.pages || b.ms >= 60000).sort((a, b) => b.ms - a.ms);
      for (const b of livros.slice(0, 2)) c.append(el('span', 'cal-livro', tituloCurto(b.name)));
      if (livros.length > 2) c.append(el('span', 'cal-mais', `+${livros.length - 2}`));
    }
    grade.append(c);
  }
  s.append(grade);
  return s;
}

/* ---------- Janela de baixo ---------- */

function openSheet(content) {
  $('sheet-body').replaceChildren(content);
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet-fechar').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

for (const b of document.querySelectorAll('.nav button')) b.onclick = () => showView(b.dataset.view);

const cleanName = (n) => n.replace(/(\.pdf)+$/i, '').replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim() || 'Sem título';

els.file.addEventListener('change', async () => {
  const files = [...els.file.files];
  els.file.value = '';
  if (!files.length) return;

  navigator.storage?.persist?.().catch(() => {});

  const all = await store.allMeta();
  let last = null, added = 0;
  for (const file of files) {
    const name = cleanName(file.name);
    const existing = all.find((b) => (b.name === name || b.name === file.name.replace(/\.pdf$/i, '')) && b.size === file.size);
    if (existing) { last = existing.id; continue; }
    if (files.length > 1) toast(`Adicionando ${added + 1} de ${files.length}…`, 60000);
    const id = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2));
    const buf = await file.arrayBuffer();
    await store.putFile(id, buf);
    await store.putMeta({ id, name, size: file.size, pages: 0, page: 1, opened: false, tags: [], updated: Date.now() - added });
    last = id; added++;
  }
  if (files.length === 1 && last) return openBook(last, added === 1);
  if (added) toast(added === 1 ? '1 livro adicionado' : `${added} livros adicionados`);
  renderView();
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
  els.title.textContent = cleanName(book.name);
  applyTheme();
  if (history.state?.folha !== 'reader') history.pushState({ folha: 'reader' }, '');

  try {
    task = pdfjsLib.getDocument({ data: new Uint8Array(buf), ...DOC_OPTS });
    doc = await task.promise;
  } catch (err) {
    console.error(err);
    if (isNew) await store.remove(id);
    toast('Não consegui abrir esse arquivo. Confere se ele é um PDF válido.');
    return closeReader();
  }

  book.pages = doc.numPages;
  book.opened = true;
  pend = { ms: 0, pages: 0 };
  lastActive = Date.now();
  els.slider.max = doc.numPages;
  crops.clear();
  clearCache();
  texts.clear();
  const start = Math.min(Math.max(1, book.page || 1), doc.numPages);
  if (mode === 'texto' && book.semTexto === undefined) await checkText(start);
  applyMode();
  goTo(start, { frac: book.frac || 0 });
}

// PDF escaneado (foto da página) não tem texto: esse livro fica no modo Página
async function checkText(start) {
  let chars = 0;
  for (let n = start; n < start + 6 && n <= doc.numPages; n++) {
    for (const p of await getText(n)) chars += p.s.length;
    if (chars > 60) break;
  }
  if (chars <= 60 && start > 1) {
    for (let n = 1; n <= Math.min(6, doc.numPages); n++) for (const p of await getText(n)) chars += p.s.length;
  }
  book.semTexto = chars <= 60;
  if (book.semTexto) toast('Esse PDF é imagem, então abre no modo Página');
}

async function closeReader() {
  activity();
  await flushLog();
  lastActive = 0;
  token++;
  saveProgress(true);
  clearCache();
  texts.clear();
  els.stage.replaceChildren();
  current = null;
  doc = null;
  if (task) { task.destroy().catch(() => {}); task = null; }
  book = null;
  els.reader.hidden = true;
  els.library.hidden = false;
  applyTheme();
  setTimeout(() => renderView(), 150);   // espera gravar o progresso
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

function goTo(n, at = {}) {
  return textMode() ? goToText(n, at) : goToPage(n);
}

async function goToPage(n) {
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

function next() {
  if (!doc) return;
  setUI(false);
  if (textMode()) {
    measureScreens();
    if (screen < screens - 1) { activity(); return showScreen(screen + 1); }
    if (pageNum < doc.numPages) { countPage(); goToText(pageNum + 1, { screen: 'first', dir: 1 }); }
    return;
  }
  if (pageNum < doc.numPages) { countPage(); goTo(pageNum + 1); }
}
function prev() {
  if (!doc) return;
  setUI(false);
  activity();
  if (textMode()) {
    measureScreens();
    if (screen > 0) return showScreen(screen - 1);
    if (pageNum > 1) goToText(pageNum - 1, { screen: 'last', dir: -1 });
    return;
  }
  if (pageNum > 1) goTo(pageNum - 1);
}

/* ---------- Modo Texto: letra ajustável, vira a tela com toque ---------- */

const texts = new Map();   // página -> parágrafos (do livro aberto)
let screen = 0;            // tela atual dentro da página do PDF
let screens = 1;           // quantas telas essa página ocupou
let flowEl = null;
let flowW = 0;

function getText(n) {
  if (!texts.has(n)) {
    const pdf = doc;
    const job = pdf.getPage(n).then(extractPage).catch(() => []);
    texts.set(n, job);
  }
  return texts.get(n);
}

// Tira o texto de uma página do PDF e remonta em parágrafos
async function extractPage(page) {
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };

  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform;
    const h = Math.hypot(t[2], t[3]) || 10;
    const x = t[4], y = t[5];
    if (it.str) {
      if (cur && Math.abs(y - cur.y) > Math.max(h, cur.h) * 0.6) push();
      if (!cur) cur = { text: '', y, h, x0: x, x1: x, hw: 0, n: 0 };
      else if (x - cur.x1 > h * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += it.str;
      cur.x1 = Math.max(cur.x1, x + (it.width || 0));
      cur.h = Math.max(cur.h, h);
      const len = it.str.trim().length;
      cur.hw += h * len; cur.n += len; // tamanho "típico" da linha (ignora letra capitular)
    }
    if (it.hasEOL) push();
  }
  push();
  if (!lines.length) return [];

  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  const medH = pick(sorted(lines.map((l) => (l.n ? l.hw / l.n : l.h))), 0.5);
  const right = pick(sorted(lines.map((l) => l.x1)), 0.9);
  const left = pick(sorted(lines.map((l) => l.x0)), 0.1);
  const width = Math.max(1, right - left);
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0 && g < medH * 4) gaps.push(g);
  }
  const medGap = gaps.length ? pick(sorted(gaps), 0.5) : medH * 1.3;

  const paras = [];
  let p = null, prev = null, dropCap = '';
  for (const l of lines) {
    let text = l.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^\d{1,4}$/.test(text)) continue; // número de página solto
    const typical = l.n ? l.hw / l.n : l.h;
    // letra capitular sozinha numa linha: gruda na palavra seguinte
    if (/^\p{L}$/u.test(text) && typical > medH * 1.2) { dropCap = text; continue; }
    if (dropCap) { text = dropCap + text; dropCap = ''; p = null; }
    const isHead = typical > medH * 1.2 && text.length < 140;
    const gapPrev = prev ? prev.y - l.y : Infinity;
    // título que quebrou em duas linhas continua sendo um título só
    if (isHead && p && p.t === 'h' && gapPrev > 0 && gapPrev < typical * 2.2) {
      p.s += ' ' + text;
      prev = l;
      continue;
    }
    let brk = !p || isHead || p.t === 'h';
    if (!brk && prev) {
      const gap = prev.y - l.y;
      const prevShort = prev.x1 < right - width * 0.12;
      if (gap > medGap * 1.4 || gap < 0) brk = true;
      else if (prevShort && /[.!?:;…"”')]$/.test(p.s)) brk = true;
      else if (l.x0 > left + medH * 1.2 && prevShort) brk = true;
      else if (/^([•▪●◦\-–—*]\s|\d{1,3}[.)]\s)/.test(text)) brk = true;
    }
    if (brk) {
      p = { t: isHead ? 'h' : 'p', s: text };
      paras.push(p);
    } else if (/[a-zà-ÿ]-$/i.test(p.s) && /^[a-zà-ÿ]/.test(text)) {
      p.s = p.s.slice(0, -1) + text; // junta palavra hifenizada
    } else {
      p.s += ' ' + text;
    }
    prev = l;
  }
  return paras;
}

function showScreen(i) {
  screen = Math.min(Math.max(0, i), screens - 1);
  if (flowEl) flowEl.style.transform = `translateX(${-screen * flowW}px)`;
  saveProgress();
}

function layoutFlow() {
  if (!flowEl) return;
  const clip = flowEl.parentElement;
  flowW = clip.clientWidth;
  flowEl.style.fontSize = `${fontSize}px`;
  flowEl.classList.toggle('ragged', fontSize > 24);
  flowEl.style.width = `${flowW}px`;
  flowEl.style.columnWidth = `${flowW}px`;
  flowEl.style.transform = 'none';
  measureScreens();
}

// quantas colunas (telas) o texto da página ocupou
function measureScreens() {
  if (!flowEl) return screens;
  const w = flowEl.parentElement.clientWidth;
  if (w && w !== flowW) { layoutFlow(); return screens; }
  screens = Math.max(1, Math.round(flowEl.scrollWidth / flowW));
  return screens;
}

async function goToText(n, at = {}) {
  if (!doc) return;
  n = Math.min(Math.max(1, n), doc.numPages);
  pageNum = n;
  const mine = ++token;
  updateBar();

  const paras = await getText(n);
  if (mine !== token) return;

  // página sem texto (só imagem): pula na direção do movimento
  if (!paras.length && at.dir && n + at.dir >= 1 && n + at.dir <= doc.numPages) {
    return goToText(n + at.dir, at);
  }
  if (!paras.length && !at.dir && n < doc.numPages && at.skip !== false) {
    return goToText(n + 1, { ...at, dir: 1 });
  }

  const view = document.createElement('div');
  view.className = 'flow-view';
  const clip = document.createElement('div');
  clip.className = 'flow-clip';
  const flow = document.createElement('div');
  flow.className = 'flow';
  flow.lang = 'pt-BR';
  if (!paras.length) {
    const p = document.createElement('p');
    p.className = 'flow-empty';
    p.textContent = 'Esta página não tem texto. Para ver, use o modo Página.';
    flow.append(p);
  }
  for (const p of paras) {
    const el = document.createElement(p.t === 'h' ? 'h2' : 'p');
    el.textContent = p.s;
    flow.append(el);
  }
  clip.append(flow);
  view.append(clip);
  current = null;
  els.stage.replaceChildren(view);
  clearCache();
  flowEl = flow;
  els.loading.hidden = true;
  layoutFlow();
  await new Promise(requestAnimationFrame);
  if (mine !== token) return;
  measureScreens();

  let i = 0;
  if (at.screen === 'last') i = screens - 1;
  else if (typeof at.frac === 'number') i = Math.round(at.frac * screens);
  showScreen(i);

  // deixa a próxima página pronta
  setTimeout(() => { if (mine === token && doc && n < doc.numPages) getText(n + 1); }, 60);
}

function setFont(px) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
  prefs.set('fonte', String(fontSize));
  els.fontSize.textContent = fontSize;
  if (!flowEl || !textMode()) return;
  const frac = screens > 1 ? screen / screens : 0;
  layoutFlow();
  showScreen(Math.round(frac * screens));
}

let saveTimer = null;
function saveProgress(now = false) {
  if (!book) return;
  book.page = pageNum;
  book.frac = textMode() && screens > 1 ? screen / screens : 0;
  book.updated = Date.now();
  const snapshot = { ...book };
  clearTimeout(saveTimer);
  const write = async () => {
    const cur = await store.getMeta(snapshot.id).catch(() => null);
    if (!cur) return;   // livro removido
    const { page, frac, updated, pages, semTexto, opened, ms, read } = snapshot;
    await store.putMeta({ ...cur, page, frac, updated, pages, semTexto, opened, ms, read }).catch(() => {});
  };
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
els.slider.addEventListener('change', () => { activity(); goTo(Number(els.slider.value)); });

els.modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.mode === (textMode() ? 'texto' : 'pagina')) return;
  if (b.dataset.mode === 'texto' && book?.semTexto) { toast('Esse PDF é imagem, não tem texto pra mostrar'); return; }
  mode = b.dataset.mode;
  prefs.set('mode', mode);
  applyMode();
  flowEl = null;
  if (doc) goTo(pageNum, { skip: false });
});

els.fontDown.addEventListener('click', () => setFont(fontSize - 2));
els.fontUp.addEventListener('click', () => setFont(fontSize + 2));
els.fontSize.addEventListener('click', () => setFont(FONT_PADRAO));

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
    if (textMode() && flowEl) { setFont(fontSize); return; }
    goTo(pageNum);
  }, 150);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    activity();
    flushLog();
    lastActive = 0;          // app fechado não conta como leitura
    saveProgress(true);
  } else if (book) {
    lastActive = Date.now();
  }
});

/* ---------- Início ---------- */

if (!THEMES.includes(theme)) theme = 'claro';
if (fit !== 'largura') fit = 'pagina';
if (mode !== 'pagina') mode = 'texto';
applyTheme();
applyFit();
applyMode();
if (history.state?.folha === 'reader') history.replaceState(null, '');
showView('inicio');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

