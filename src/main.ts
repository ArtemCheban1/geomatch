import './style.css';
import { computeGeoref, lngLatToPixel, pixelToLngLat, type Georef } from './geo/georef';
import { mercToLngLat, type LngLat } from './geo/mercator';
import { applyTransform, TRANSFORMS, transformInfo, type Pt, type TransformKind } from './geo/transforms';
import { WarpClient } from './geo/warpClient';
import type { WarpResult } from './geo/warp';
import {
  download,
  exportGeoPng,
  exportPoisGeoJson,
  exportProject,
  exportQgisPoints,
  importPoisGeoJson,
  importProject,
  importQgisPoints,
  baseName,
} from './io';
import {
  initialUi,
  loadProject,
  newProject,
  normalizeProject,
  Store,
  uid,
  type BasemapId,
  type CompareMode,
  type Layer,
  type Mode,
  type View,
} from './state';
import { mergeManifest } from './refLayers';
import { Explore } from './ui/explore';
import { ImageView } from './ui/imageView';
import { BASEMAPS, MapView } from './ui/mapView';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = new Store();
const warp = new WarpClient();

interface LayerFit {
  georef: Georef | null;
  /** georef actually used for display (may be a Helmert preview) */
  display: Georef | null;
  preview: boolean;
  previewKind?: TransformKind;
  error: string | null;
}
const fits = new Map<string, LayerFit>();
const registeredSources = new Set<string>();
const warpSeq = new Map<string, number>();
const warpTimers = new Map<string, number>();

/** Last warped raster per layer (re-used by the compare map). */
const warpResults = new Map<string, WarpResult>();

let imageView: ImageView;
let mapView: MapView;
let explore: Explore;

// ---------------------------------------------------------------- helpers

function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  window.clearTimeout((t as any)._timer);
  (t as any)._timer = window.setTimeout(() => (t.className = 'toast'), kind === 'error' ? 6000 : 3000);
}

function fmtMeters(m: number): string {
  if (m < 1) return `${(m * 100).toFixed(0)} см`;
  if (m < 1000) return `${m.toFixed(1)} м`;
  return `${(m / 1000).toFixed(2)} км`;
}

function errorClass(err: number, rmse: number): string {
  if (rmse === 0) return '';
  if (err > rmse * 2) return 'bad';
  if (err > rmse * 1.3) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------- fitting & warping

function fitLayer(layer: Layer): LayerFit {
  const fit: LayerFit = { georef: null, display: null, preview: false, error: null };
  try {
    fit.georef = computeGeoref(layer.transform, layer.points);
    fit.display = fit.georef;
    if (!fit.georef) {
      // Not enough points for the chosen transform yet — preview with the
      // most capable simpler one, so the map shows up as early as possible.
      const n = layer.points.filter((p) => p.enabled).length;
      const fallback: TransformKind | null = n >= 3 ? 'affine' : n >= 2 ? 'helmert' : null;
      if (fallback) {
        fit.display = computeGeoref(fallback, layer.points);
        fit.preview = true;
        fit.previewKind = fallback;
      }
    }
  } catch (e) {
    fit.error = (e as Error).message;
  }
  fits.set(layer.id, fit);
  return fit;
}

async function ensureSource(layer: Layer): Promise<void> {
  if (registeredSources.has(layer.id)) return;
  registeredSources.add(layer.id);
  await warp.setSource(layer.id, layer.image, layer.clip);
}

function scheduleWarp(layer: Layer, delay = 120): void {
  window.clearTimeout(warpTimers.get(layer.id));
  warpTimers.set(
    layer.id,
    window.setTimeout(() => void runWarp(layer), delay),
  );
}

async function runWarp(layer: Layer): Promise<void> {
  const fit = fits.get(layer.id) ?? fitLayer(layer);
  if (!fit.display) {
    mapView.removeOverlay(layer.id);
    explore.removeOverlay(layer.id);
    warpResults.delete(layer.id);
    return;
  }
  const seq = (warpSeq.get(layer.id) ?? 0) + 1;
  warpSeq.set(layer.id, seq);
  await ensureSource(layer);
  try {
    const res = await warp.warp(layer.id, {
      forward: fit.display.forward,
      inverse: fit.display.inverse,
      imageWidth: layer.width,
      imageHeight: layer.height,
      maxOutputSize: 4096,
    });
    if (warpSeq.get(layer.id) !== seq) return; // stale
    if (!store.project.layers.includes(layer)) return; // deleted meanwhile
    warpResults.set(layer.id, res);
    await mapView.setOverlay(layer, res);
    explore.onOverlay(layer, res);
  } catch (e) {
    if (warpSeq.get(layer.id) === seq) toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- control point editing

function completePending(): void {
  const layer = store.activeLayer;
  const pend = store.ui.pending;
  if (!layer || !pend?.img || !pend.lngLat) return;
  const id = uid();
  layer.points.push({ id, img: pend.img, lngLat: pend.lngLat, enabled: true });
  store.ui.pending = null;
  store.ui.selectedPointId = id;
  store.emit('points');
}

function addImagePoint(p: Pt): void {
  if (!store.activeLayer) return;
  const pend = store.ui.pending;
  if (pend?.lngLat && !pend.img) {
    pend.img = p;
    completePending();
  } else {
    store.ui.pending = { img: p };
    store.ui.selectedPointId = null;
    store.emit('ui');
  }
}

function addMapPoint(ll: LngLat): void {
  if (!store.activeLayer) {
    toast('Спочатку додайте зображення карти.');
    return;
  }
  const pend = store.ui.pending;
  if (pend?.img && !pend.lngLat) {
    pend.lngLat = ll;
    completePending();
  } else {
    store.ui.pending = { lngLat: ll };
    store.ui.selectedPointId = null;
    store.emit('ui');
  }
}

function movePoint(id: string, patch: { img?: Pt; lngLat?: LngLat }): void {
  const layer = store.activeLayer;
  const p = layer?.points.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  store.emit('points');
}

function selectPoint(id: string | null, center = false): void {
  store.ui.selectedPointId = id;
  store.emit('ui');
  if (center && id) {
    const p = store.activeLayer?.points.find((x) => x.id === id);
    if (p) {
      imageView.centerOn(p.img);
      mapView.panTo(p.lngLat);
    }
  }
}

function deletePoint(id: string): void {
  const layer = store.activeLayer;
  if (!layer) return;
  layer.points = layer.points.filter((p) => p.id !== id);
  if (store.ui.selectedPointId === id) store.ui.selectedPointId = null;
  store.emit('points');
}

function cancelPending(): void {
  if (store.ui.pending || store.ui.clipDraft) {
    store.ui.pending = null;
    store.ui.clipDraft = null;
    store.emit('ui');
  }
}

// ---------------------------------------------------------------- clip

function clipClick(p: Pt): void {
  store.ui.clipDraft = [...(store.ui.clipDraft ?? []), p];
  store.emit('ui');
}

function clipFinish(): void {
  const layer = store.activeLayer;
  const draft = store.ui.clipDraft;
  if (!layer || !draft) return;
  // dblclick also fired a click — drop the duplicate vertex
  const pts = draft.filter((p, i) => i === 0 || Math.hypot(p.x - draft[i - 1].x, p.y - draft[i - 1].y) > 1);
  store.ui.clipDraft = null;
  if (pts.length < 3) {
    toast('Для обрізки потрібно щонайменше 3 вершини.');
    store.emit('ui');
    return;
  }
  setClip(layer, pts);
  setMode('points');
}

function setClip(layer: Layer, clip: Pt[] | null): void {
  layer.clip = clip;
  warp.setClip(layer.id, clip);
  store.emit('layers');
  scheduleWarp(layer, 0);
}

// ---------------------------------------------------------------- nudge (rubber-sheet fine tuning)

/**
 * Checks that nudging is possible and switches the layer to TPS, which passes
 * exactly through every control point — so a dragged spot lands exactly where
 * it is dropped while the rest of the map stays pinned by the other points.
 */
function prepareNudge(): boolean {
  const layer = store.activeLayer;
  const fit = layer ? fits.get(layer.id) : undefined;
  if (!layer || !fit?.display) {
    toast('Спочатку прив\'яжіть карту хоча б за 2–3 точками.');
    return false;
  }
  if (layer.transform !== 'tps') {
    layer.transform = 'tps';
    store.emit('points');
    toast('Перемкнено на «гумовий лист» (TPS): карта точно проходитиме через кожну точку.');
  }
  return true;
}

function nudgeStart(ll: LngLat): string | null {
  const layer = store.activeLayer;
  const g = layer ? fits.get(layer.id)?.display : null;
  if (!layer || !g) return null;
  const img = lngLatToPixel(g, ll);
  if (!(img.x >= 0 && img.y >= 0 && img.x <= layer.width && img.y <= layer.height)) {
    toast('Тягніть саму накладену карту — тут її немає.');
    return null;
  }
  const id = uid();
  layer.points.push({ id, img, lngLat: ll, enabled: true });
  store.ui.selectedPointId = id;
  store.emit('points');
  return id;
}

function nudgeEnd(id: string, moved: boolean): void {
  // a plain click without dragging shouldn't leave a useless point behind
  if (!moved) deletePoint(id);
}

function setMode(mode: Mode): void {
  if (store.ui.mode === mode) return;
  if (mode === 'nudge' && !prepareNudge()) return;
  store.ui.mode = mode;
  store.ui.pending = null;
  store.ui.clipDraft = mode === 'clip' ? [] : null;
  store.emit('ui');
}

// ---------------------------------------------------------------- layers

async function addImageFiles(files: FileList | File[]): Promise<void> {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) {
      toast(`${file.name}: це не зображення`, 'error');
      continue;
    }
    try {
      const bmp = await createImageBitmap(file);
      const layer: Layer = {
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ''),
        image: file,
        width: bmp.width,
        height: bmp.height,
        points: [],
        transform: 'affine',
        opacity: 0.7,
        visible: true,
        clip: null,
      };
      bmp.close();
      store.project.layers.push(layer);
      store.project.activeLayerId = layer.id;
      store.ui.pending = null;
      store.ui.selectedPointId = null;
      store.emit('layers');
    } catch {
      toast(`Не вдалося прочитати ${file.name}`, 'error');
    }
  }
}

function setActiveLayer(id: string): void {
  if (store.project.activeLayerId === id) return;
  store.project.activeLayerId = id;
  store.ui.pending = null;
  store.ui.selectedPointId = null;
  store.ui.clipDraft = store.ui.mode === 'clip' ? [] : null;
  store.emit('layers');
}

function deleteLayer(id: string): void {
  const layer = store.project.layers.find((l) => l.id === id);
  if (!layer) return;
  if (layer.points.length && !confirm(`Видалити «${layer.name}» разом з ${layer.points.length} точками?`)) return;
  store.project.layers = store.project.layers.filter((l) => l.id !== id);
  mapView.removeOverlay(id);
  explore.removeOverlay(id);
  warpResults.delete(id);
  warp.drop(id);
  registeredSources.delete(id);
  fits.delete(id);
  if (store.project.activeLayerId === id) store.project.activeLayerId = store.project.layers.at(-1)?.id ?? null;
  store.emit('layers');
}

function moveLayer(id: string, dir: -1 | 1): void {
  const ls = store.project.layers;
  const i = ls.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ls.length) return;
  [ls[i], ls[j]] = [ls[j], ls[i]];
  store.emit('style');
  renderLayers();
}

async function loadIntoStore(p: ReturnType<typeof newProject>): Promise<void> {
  for (const id of registeredSources) warp.drop(id);
  registeredSources.clear();
  for (const l of store.project.layers) {
    mapView.removeOverlay(l.id);
    explore.removeOverlay(l.id);
  }
  fits.clear();
  warpResults.clear();
  for (const r of store.project.refLayers) mapView.removeRefLayer(r.id);
  store.project = normalizeProject(p);
  await mergeManifest(store.project);
  store.ui = { ...initialUi(), view: store.ui.view };
  store.emit('load');
  mapView.setBasemap(p.basemap);
  for (const l of p.layers) {
    fitLayer(l);
    scheduleWarp(l, 0);
  }
  if (p.view) mapView.map.jumpTo({ center: p.view.center, zoom: p.view.zoom });
}

// ---------------------------------------------------------------- rendering of side panels

function renderLayers(): void {
  const ul = $('layer-list');
  const { layers, activeLayerId } = store.project;
  if (!layers.length) {
    ul.innerHTML = '<li class="muted small empty-row">Ще немає карт. Додайте скан або фото.</li>';
    return;
  }
  ul.innerHTML = '';
  [...layers].reverse().forEach((l) => {
    const fit = fits.get(l.id);
    const li = document.createElement('li');
    li.className = `layer-item${l.id === activeLayerId ? ' active' : ''}`;
    const status = fit?.georef
      ? fit.georef.redundant
        ? `RMSE ${fmtMeters(fit.georef.rmse)}`
        : 'прив\'язано'
      : `${l.points.length} т.`;
    li.innerHTML = `
      <input type="checkbox" class="vis" title="Показувати на карті" ${l.visible ? 'checked' : ''}>
      <div class="layer-main">
        <div class="layer-name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</div>
        <div class="muted small">${l.width}×${l.height} · ${status}${l.clip ? ' · ✂' : ''}</div>
      </div>
      <div class="layer-actions">
        <button class="icon-btn" data-act="up" title="Вище">▲</button>
        <button class="icon-btn" data-act="down" title="Нижче">▼</button>
        <button class="icon-btn" data-act="rename" title="Перейменувати">✎</button>
        <button class="icon-btn danger" data-act="del" title="Видалити">✕</button>
      </div>`;
    li.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.dataset.act;
      if (t.classList.contains('vis')) {
        l.visible = (t as HTMLInputElement).checked;
        store.emit('style');
        return;
      }
      if (act === 'up') return moveLayer(l.id, 1);
      if (act === 'down') return moveLayer(l.id, -1);
      if (act === 'del') return deleteLayer(l.id);
      if (act === 'rename') {
        const name = prompt('Назва карти', l.name);
        if (name) store.updateLayer(l.id, { name }, 'layers');
        return;
      }
      setActiveLayer(l.id);
    });
    ul.appendChild(li);
  });
}

function renderTransform(): void {
  const layer = store.activeLayer;
  const sel = $<HTMLSelectElement>('transform-select');
  const panel = $('transform-panel');
  panel.classList.toggle('disabled', !layer);
  if (!layer) {
    $('fit-status').innerHTML = '';
    $('transform-desc').textContent = '';
    return;
  }
  sel.value = layer.transform;
  const info = transformInfo(layer.transform);
  $('transform-desc').textContent = info.description;

  const fit = fits.get(layer.id);
  const n = layer.points.filter((p) => p.enabled).length;
  let html = '';
  if (fit?.error) {
    html = `<div class="status error">⚠ ${escapeHtml(fit.error)}</div>`;
  } else if (fit?.georef) {
    const g = fit.georef;
    html = g.redundant
      ? `<div class="status ok">Середня похибка (RMSE): <b>${fmtMeters(g.rmse)}</b></div>`
      : g.kind === 'tps'
        ? `<div class="status ok">Прив'язано. TPS проходить точно через кожну точку, тому похибка завжди 0 — перевіряйте збіг візуально.</div>`
        : `<div class="status ok">Прив'язано. Додайте ще точку, щоб оцінити точність.</div>`;
    const scale = estimateScale(layer, g);
    if (scale) html += `<div class="muted small">≈ ${scale}</div>`;
  } else {
    const need = info.minPoints - n;
    html = `<div class="status">Потрібно ще <b>${need}</b> ${plural(need, 'точка', 'точки', 'точок')}.</div>`;
    if (fit?.preview && fit.previewKind) {
      html += `<div class="muted small">Поки що попередній перегляд: ${transformInfo(fit.previewKind).label}.</div>`;
    }
  }
  $('fit-status').innerHTML = html;
}

/** Ground metres per image pixel near the image centre. */
function estimateScale(layer: Layer, g: Georef): string | null {
  const c = { x: layer.width / 2, y: -layer.height / 2 };
  const a = applyTransform(g.forward, c);
  const b = applyTransform(g.forward, { x: c.x + 1, y: c.y });
  const lat = mercToLngLat(a)[1];
  const m = Math.hypot(b.x - a.x, b.y - a.y) * Math.cos((lat * Math.PI) / 180);
  if (!Number.isFinite(m)) return null;
  return `${fmtMeters(m)} на піксель`;
}

function renderPoints(): void {
  const layer = store.activeLayer;
  const tbody = $('points-body');
  const points = layer?.points ?? [];
  const fit = layer ? fits.get(layer.id) : undefined;
  const g = fit?.georef;
  $('point-count').textContent = points.length ? `(${points.length})` : '';
  if (!layer) {
    tbody.innerHTML = '';
    return;
  }
  if (!points.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted small empty-row">Клікніть місце на зображенні, а потім те саме місце на карті.</td></tr>`;
    return;
  }
  tbody.innerHTML = points
    .map((p, i) => {
      const r = g?.residuals[p.id];
      const err = r && g!.redundant ? `<span class="err ${errorClass(r.error, g!.rmse)}">${fmtMeters(r.error)}</span>` : '—';
      return `<tr data-id="${p.id}" class="${p.id === store.ui.selectedPointId ? 'selected' : ''}${p.enabled ? '' : ' off'}">
        <td>${i + 1}</td>
        <td><input type="checkbox" data-act="toggle" ${p.enabled ? 'checked' : ''}></td>
        <td class="mono">${p.img.x.toFixed(0)}, ${p.img.y.toFixed(0)}</td>
        <td class="mono">${p.lngLat[1].toFixed(5)}, ${p.lngLat[0].toFixed(5)}</td>
        <td>${err}</td>
        <td><button class="icon-btn danger" data-act="del" title="Видалити точку">✕</button></td>
      </tr>`;
    })
    .join('');
}

function renderModeAndHint(): void {
  const { mode, pending } = store.ui;
  document.querySelectorAll<HTMLButtonElement>('#mode-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const layer = store.activeLayer;
  $('clip-clear').style.display = layer?.clip ? '' : 'none';
  $('image-empty').style.display = layer ? 'none' : '';

  let hint = '';
  if (!layer) hint = 'Додайте скан або фото карти, щоб почати.';
  else if (mode === 'clip') {
    const n = store.ui.clipDraft?.length ?? 0;
    hint = n < 3
      ? 'Обрізка: клікайте вершини області, яку треба залишити.'
      : 'Обрізка: подвійний клік або Enter — завершити, Esc — скасувати.';
  } else if (mode === 'pan') hint = 'Режим огляду: кліки не створюють точок.';
  else if (mode === 'nudge') hint = '🧲 Підтягнути: схопіть накладену карту там, де вона не збігається (дорога, перехрестя), і перетягніть на правильне місце. Esc — вийти.';
  else if (pending?.img) hint = `Точка ${layer.points.length + 1}: тепер клікніть <b>те саме місце на карті</b> праворуч. Esc — скасувати.`;
  else if (pending?.lngLat) hint = `Точка ${layer.points.length + 1}: тепер клікніть <b>те саме місце на зображенні</b> ліворуч. Esc — скасувати.`;
  else if (layer.points.length < 3) hint = 'Клікніть характерне місце на зображенні (перехрестя, церква, міст…), потім те саме місце на карті.';
  else hint = 'Додавайте точки по кутах карти для точності. Перетягуйте маркери, щоб уточнити.';
  $('hint').innerHTML = hint;
  $('nudge-btn').classList.toggle('active', mode === 'nudge');
  document.querySelectorAll<HTMLButtonElement>('#view-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === store.ui.view);
  });

  // overlay controls
  const op = $<HTMLInputElement>('overlay-opacity');
  op.disabled = !layer;
  if (layer) op.value = String(layer.opacity);
  $('overlay-toggle').classList.toggle('active', !!layer?.visible);
}

function updateGhosts(): void {
  const layer = store.activeLayer;
  const fit = layer ? fits.get(layer.id) : undefined;
  const g = fit?.display;
  const pend = store.ui.pending;
  mapView.setGhost(g && pend?.img && !pend.lngLat ? pixelToLngLat(g, pend.img) : null);
  imageView.setGhost(g && pend?.lngLat && !pend.img ? lngLatToPixel(g, pend.lngLat) : null);
}

function residualLines(): [LngLat, LngLat][] {
  const layer = store.activeLayer;
  const g = layer ? fits.get(layer.id)?.georef : null;
  if (!layer || !g || !g.redundant) return [];
  return layer.points
    .filter((p) => p.enabled)
    .map((p) => [p.lngLat, pixelToLngLat(g, p.img)] as [LngLat, LngLat]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// ---------------------------------------------------------------- store → views

function onChange(reason: string): void {
  const layer = store.activeLayer;
  if (reason === 'points' && layer) {
    fitLayer(layer);
    scheduleWarp(layer);
  }
  if (reason === 'layers' || reason === 'load') {
    void imageView.syncLayer();
    for (const l of store.project.layers) if (!fits.has(l.id)) fitLayer(l);
    $<HTMLInputElement>('project-name').value = store.project.name;
    $<HTMLSelectElement>('basemap-select').value = store.project.basemap;
  }
  if (reason === 'style' || reason === 'layers' || reason === 'load') mapView.syncOverlayStyles();
  explore.render();

  renderLayers();
  renderTransform();
  renderPoints();
  renderModeAndHint();
  mapView.syncPoints(residualLines());
  updateGhosts();
  imageView.requestRender();
}

// ---------------------------------------------------------------- UI wiring

function initControls(): void {
  // transform select
  const sel = $<HTMLSelectElement>('transform-select');
  sel.innerHTML = TRANSFORMS.map((t) => `<option value="${t.kind}">${t.label} — від ${t.minPoints} точок</option>`).join('');
  sel.addEventListener('change', () => {
    const layer = store.activeLayer;
    if (!layer) return;
    layer.transform = sel.value as TransformKind;
    store.emit('points');
  });

  // basemap
  const bm = $<HTMLSelectElement>('basemap-select');
  bm.innerHTML = BASEMAPS.map((b) => `<option value="${b.id}">${b.label}</option>`).join('');
  bm.value = store.project.basemap;
  bm.addEventListener('change', () => {
    store.project.basemap = bm.value as BasemapId;
    mapView.setBasemap(store.project.basemap);
    explore.setBasemap();
    store.emit('style');
  });

  // project name
  $<HTMLInputElement>('project-name').addEventListener('change', (e) => {
    store.project.name = (e.target as HTMLInputElement).value || 'Без назви';
    store.emit('style');
  });

  // add image
  $<HTMLInputElement>('add-image').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) void addImageFiles(input.files);
    input.value = '';
  });

  // drag & drop anywhere
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer?.files.length) void addImageFiles(e.dataTransfer.files);
  });

  // modes
  document.querySelectorAll<HTMLButtonElement>('#mode-switch button').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
  );
  $('clip-clear').addEventListener('click', () => {
    const l = store.activeLayer;
    if (l) setClip(l, null);
  });

  // image zoom
  $('img-zoom-in').addEventListener('click', () => imageView.zoomBy(1.5));
  $('img-zoom-out').addEventListener('click', () => imageView.zoomBy(1 / 1.5));
  $('img-fit').addEventListener('click', () => imageView.fit());

  // overlay controls
  $<HTMLInputElement>('overlay-opacity').addEventListener('input', (e) => {
    const l = store.activeLayer;
    if (!l) return;
    l.opacity = Number((e.target as HTMLInputElement).value);
    store.emit('style');
  });
  $('overlay-toggle').addEventListener('click', toggleOverlay);
  $('overlay-fit').addEventListener('click', () => {
    const l = store.activeLayer;
    if (l && mapView.hasOverlay(l.id)) mapView.fitOverlay(l.id);
    else toast('Накладка з\'явиться після 2 контрольних точок.');
  });

  // points table
  $('points-body').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest('tr');
    const id = row?.dataset.id;
    if (!id) return;
    if (t.dataset.act === 'del') return deletePoint(id);
    if (t.dataset.act === 'toggle') {
      const p = store.activeLayer?.points.find((x) => x.id === id);
      if (p) {
        p.enabled = (t as HTMLInputElement).checked;
        store.emit('points');
      }
      return;
    }
    selectPoint(id, true);
  });

  // search (Nominatim)
  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('search-input').value.trim();
    if (!q) return;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=uk&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = (await res.json()) as { boundingbox: string[]; display_name: string }[];
      if (!data.length) return toast('Нічого не знайдено');
      const [s, n, w, ea] = data[0].boundingbox.map(Number);
      mapView.flyToBbox([w, s, ea, n]);
      toast(data[0].display_name);
    } catch {
      toast('Пошук недоступний', 'error');
    }
  });

  // file menu
  const menu = $('file-menu');
  $('file-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.action;
    if (act) void fileAction(act);
  });
  $<HTMLInputElement>('open-project-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      await loadIntoStore(await importProject(await f.text()));
      toast('Проєкт відкрито');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  $<HTMLInputElement>('import-points-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    const layer = store.activeLayer;
    if (!f || !layer) return;
    const pts = importQgisPoints(await f.text());
    if (!pts.length) return toast('У файлі не знайдено точок', 'error');
    layer.points.push(...pts);
    store.emit('points');
    toast(`Імпортовано ${pts.length} точок`);
  });

  // help
  $('help-btn').addEventListener('click', () => $<HTMLDialogElement>('help-dialog').showModal());

  // keyboard
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const l = store.activeLayer;
    const inExplore = store.ui.view === 'explore';
    if (e.key === 'Tab') {
      e.preventDefault();
      setView(inExplore ? 'georef' : 'explore');
      return;
    }
    if (e.key === 'f' || e.key === 'F') return toggleFullscreen();
    if (inExplore) {
      const compareKeys: Record<string, CompareMode> = { '1': 'overlay', '2': 'swipe', '3': 'lens', '4': 'side' };
      if (compareKeys[e.key]) return explore.setCompare(compareKeys[e.key]);
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) explore.flip(true);
        return;
      }
      if (e.key === 'm' || e.key === 'M') return explore.toggleAddPoi();
      if (e.key === 'Escape') {
        store.ui.addingPoi = false;
        store.ui.selectedPoiId = null;
        store.emit('ui');
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        cancelPending();
        if (store.ui.mode === 'clip' || store.ui.mode === 'nudge') setMode('points');
        break;
      case 'n':
      case 'N':
        setMode(store.ui.mode === 'nudge' ? 'points' : 'nudge');
        break;
      case 'Enter':
        if (store.ui.mode === 'clip') clipFinish();
        break;
      case 'Delete':
      case 'Backspace':
        if (store.ui.selectedPointId) deletePoint(store.ui.selectedPointId);
        break;
      case 'a':
      case 'A':
        setMode('points');
        break;
      case 'c':
      case 'C':
        setMode('clip');
        break;
      case 'v':
      case 'V':
        setMode('pan');
        break;
      case 'o':
      case 'O':
        toggleOverlay();
        break;
      case '[':
      case ']':
        if (l) {
          l.opacity = Math.max(0, Math.min(1, l.opacity + (e.key === ']' ? 0.1 : -0.1)));
          store.emit('style');
        }
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && store.ui.view === 'explore') explore.flip(false);
  });

  // view switch, nudge, fullscreen
  document.querySelectorAll<HTMLButtonElement>('#view-switch button').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view as View)),
  );
  $('nudge-btn').addEventListener('click', () => setMode(store.ui.mode === 'nudge' ? 'points' : 'nudge'));
  $('fullscreen-btn').addEventListener('click', toggleFullscreen);

  $<HTMLInputElement>('import-pois-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const n = importPoisGeoJson(store.project, await f.text());
      store.emit('pois');
      toast(`Імпортовано ${n} міток`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
}

function setView(view: View): void {
  if (store.ui.view === view) return;
  store.ui.view = view;
  store.ui.pending = null;
  store.ui.addingPoi = false;
  if (store.ui.mode === 'clip' || store.ui.mode === 'nudge') {
    store.ui.mode = 'points';
    store.ui.clipDraft = null;
  }
  explore.flip(false);
  store.emit('ui');
  // the map pane changes size
  requestAnimationFrame(() => mapView.map.resize());
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => toast('Повний екран недоступний'));
}

function toggleOverlay(): void {
  const l = store.activeLayer;
  if (!l) return;
  l.visible = !l.visible;
  store.emit('style');
}

async function fileAction(act: string): Promise<void> {
  $('file-menu').classList.remove('open');
  const layer = store.activeLayer;
  switch (act) {
    case 'save-project':
      await exportProject(store.project);
      break;
    case 'open-project':
      $('open-project-input').click();
      break;
    case 'new-project':
      if (store.project.layers.length && !confirm('Почати новий проєкт? Поточний буде замінено (збережіть його спершу через «Файл → Зберегти проєкт»).')) return;
      await loadIntoStore(newProject());
      break;
    case 'export-points':
      if (!layer) return toast('Немає активної карти');
      download(`${baseName(layer.name)}.points`, exportQgisPoints(layer, fits.get(layer.id)?.georef ?? null), 'text/plain');
      break;
    case 'export-pois':
      if (!store.project.pois.length) return toast('Ще немає міток');
      download(`${baseName(store.project.name)}-mitky.geojson`, exportPoisGeoJson(store.project), 'application/geo+json');
      break;
    case 'import-pois':
      $('import-pois-input').click();
      break;
    case 'import-points':
      if (!layer) return toast('Спочатку додайте зображення карти');
      $('import-points-input').click();
      break;
    case 'export-png': {
      const g = layer ? fits.get(layer.id)?.georef : null;
      if (!layer || !g) return toast('Карту ще не прив\'язано — потрібно більше точок.', 'error');
      toast('Готую PNG у повній якості…');
      const key = `export-${layer.id}`;
      try {
        await warp.setSource(key, layer.image, layer.clip, 8192);
        const res = await warp.warp(key, {
          forward: g.forward,
          inverse: g.inverse,
          imageWidth: layer.width,
          imageHeight: layer.height,
          maxOutputSize: 8192,
        });
        await exportGeoPng(layer.name, res);
        toast('Експортовано PNG + .pgw + .prj (EPSG:3857) — відкривається в QGIS/ArcGIS.');
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        warp.drop(key);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  const saved = await loadProject();
  if (saved) store.project = saved;

  imageView = new ImageView($('image-view'), store, {
    addPoint: addImagePoint,
    movePoint: (id, p) => movePoint(id, { img: p }),
    select: (id) => selectPoint(id),
    clipClick,
    clipFinish,
  });
  mapView = new MapView($('map'), store, {
    addPoint: addMapPoint,
    movePoint: (id, ll) => movePoint(id, { lngLat: ll }),
    select: (id) => selectPoint(id),
    viewChanged: (center, zoom) => {
      store.project.view = { center, zoom };
      store.save();
    },
    nudgeStart,
    nudgeMove: (id, ll) => movePoint(id, { lngLat: ll }),
    nudgeEnd,
    exploreClick: (ll) => explore.mapClick(ll),
    poiSelect: (id) => explore.selectPoi(id),
    poiMove: (id, ll) => explore.movePoi(id, ll),
    refToPoi: (title, description, ll) => explore.addPoiFromRef(title, description, ll),
  });
  explore = new Explore({ store, main: mapView, warpResults, toast });

  store.subscribe(onChange);
  initControls();
  await mapView.whenReady();
  await mergeManifest(store.project);
  store.emit('load');
  for (const l of store.project.layers) scheduleWarp(l, 0);

  if (!saved) $<HTMLDialogElement>('help-dialog').showModal();
}

void boot();
