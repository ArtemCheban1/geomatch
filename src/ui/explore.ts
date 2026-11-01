/**
 * Explore view: full-screen work with georeferenced maps.
 *  - compare old ↔ modern (or old ↔ old): overlay, swipe, lens, side-by-side, quick flip
 *  - points of interest with categories (colour, visibility), tags and notes
 */
import type { LngLat } from '../geo/mercator';
import type { WarpResult } from '../geo/warp';
import { uid, type CompareMode, type Layer, type Poi, type Store } from '../state';
import { MapView, NO_EVENTS } from './mapView';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const LENS_RADIUS = 130;
const CATEGORY_COLORS = ['#e8590c', '#e03131', '#1c7ed6', '#2b8a3e', '#9c36b5', '#f08c00', '#0c8599', '#5c940d', '#c2255c', '#495057'];

export interface ExploreDeps {
  store: Store;
  main: MapView;
  warpResults: Map<string, WarpResult>;
  toast(msg: string, kind?: 'info' | 'error'): void;
}

export class Explore {
  private store: Store;
  private main: MapView;
  private compareMap: MapView | null = null;
  private swipeX = 0.5;
  private lensPos: { x: number; y: number } | null = null;
  private syncing = false;
  private poiFilter = '';

  constructor(private deps: ExploreDeps) {
    this.store = deps.store;
    this.main = deps.main;
    this.bindControls();
    this.bindSync();
  }

  // ------------------------------------------------------------ compare

  private ensureCompareMap(): MapView {
    if (this.compareMap) return this.compareMap;
    const cm = new MapView($('compare-map'), this.store, NO_EVENTS, 'compare');
    this.compareMap = cm;
    cm.map.jumpTo(this.cameraOf(this.main));
    void cm.whenReady().then(() => {
      cm.setBasemap(this.store.project.basemap);
      for (const l of this.store.project.layers) {
        const res = this.deps.warpResults.get(l.id);
        if (res) void cm.setOverlay(l, res);
      }
    });
    // side-by-side: the compare map drives the main one too
    cm.map.on('move', (e) => {
      if (this.syncing || !(e as { originalEvent?: unknown }).originalEvent) return;
      this.syncing = true;
      this.main.map.jumpTo(this.cameraOf(cm));
      this.syncing = false;
    });
    return cm;
  }

  private cameraOf(v: MapView) {
    return { center: v.map.getCenter(), zoom: v.map.getZoom(), bearing: v.map.getBearing(), pitch: v.map.getPitch() };
  }

  private bindSync(): void {
    this.main.map.on('move', () => {
      if (this.syncing || !this.compareMap || !this.compareActive) return;
      this.syncing = true;
      this.compareMap.map.jumpTo(this.cameraOf(this.main));
      this.syncing = false;
    });
    this.main.map.on('mousemove', (e) => {
      if (!this.compareActive || this.store.ui.compare !== 'lens') return;
      this.lensPos = { x: e.point.x, y: e.point.y };
      this.applyClip();
    });
    this.main.map.getContainer().addEventListener('mouseleave', () => {
      this.lensPos = null;
      this.applyClip();
    });
  }

  private get compareActive(): boolean {
    return this.store.ui.view === 'explore' && this.store.ui.compare !== 'overlay';
  }

  /** Called on every store change. */
  syncCompare(): void {
    const ui = this.store.ui;
    const stage = $('map-stage');
    const mode: CompareMode = ui.view === 'explore' ? ui.compare : 'overlay';
    const prev = stage.dataset.compare;
    stage.dataset.compare = mode;

    if (mode !== 'overlay') {
      const cm = this.ensureCompareMap();
      cm.syncOverlayStyles();
      cm.setBasemap(this.store.project.basemap);
      if (prev !== mode) {
        // container sizes may have changed (side-by-side)
        requestAnimationFrame(() => {
          this.main.map.resize();
          cm.map.resize();
          cm.map.jumpTo(this.cameraOf(this.main));
        });
      }
    } else if (prev && prev !== 'overlay') {
      requestAnimationFrame(() => this.main.map.resize());
    }
    this.applyClip();

    const target = ui.compareLayerId
      ? this.store.project.layers.find((l) => l.id === ui.compareLayerId)?.name ?? ''
      : 'Сучасна мапа';
    const label = $('compare-label');
    label.textContent =
      mode === 'swipe' ? `◀ Старі карти  |  ${target} ▶` : mode === 'lens' ? `У лупі: ${target}` : mode === 'side' ? target : '';
  }

  private applyClip(): void {
    const el = $('compare-map');
    const mode = this.store.ui.compare;
    if (!this.compareActive) {
      el.style.clipPath = '';
      return;
    }
    const w = el.clientWidth;
    if (mode === 'swipe') {
      const x = Math.round(w * this.swipeX);
      el.style.clipPath = `inset(0 0 0 ${x}px)`;
      $('swipe-handle').style.left = `${x}px`;
    } else if (mode === 'lens') {
      el.style.clipPath = this.lensPos
        ? `circle(${LENS_RADIUS}px at ${this.lensPos.x}px ${this.lensPos.y}px)`
        : 'circle(0px at 0 0)';
    } else {
      el.style.clipPath = '';
    }
  }

  setCompare(mode: CompareMode): void {
    this.store.ui.compare = mode;
    this.store.emit('ui');
  }

  onOverlay(layer: Layer, res: WarpResult): void {
    if (this.compareMap) void this.compareMap.setOverlay(layer, res);
  }

  removeOverlay(layerId: string): void {
    this.compareMap?.removeOverlay(layerId);
  }

  setBasemap(): void {
    this.compareMap?.setBasemap(this.store.project.basemap);
  }

  // ------------------------------------------------------------ POIs

  /** Map click in explore view. */
  mapClick(ll: LngLat): void {
    const ui = this.store.ui;
    if (!ui.addingPoi) {
      if (ui.selectedPoiId) {
        ui.selectedPoiId = null;
        this.store.emit('ui');
      }
      return;
    }
    const { categories } = this.store.project;
    const lastCat = this.store.project.pois.at(-1)?.categoryId;
    const cat = categories.find((c) => c.id === lastCat && c.visible) ?? categories.find((c) => c.visible) ?? categories[0];
    if (!cat.visible) cat.visible = true;
    const poi: Poi = {
      id: uid(),
      lngLat: ll,
      title: `Мітка ${this.store.project.pois.length + 1}`,
      description: '',
      categoryId: cat.id,
      tags: [],
      createdAt: Date.now(),
    };
    this.store.project.pois.push(poi);
    ui.addingPoi = false;
    ui.selectedPoiId = poi.id;
    this.store.emit('pois');
    requestAnimationFrame(() => {
      const t = $<HTMLInputElement>('poi-title');
      t.focus();
      t.select();
    });
  }

  selectPoi(id: string | null, fly = false): void {
    this.store.ui.selectedPoiId = id;
    this.store.emit('ui');
    const poi = id ? this.store.project.pois.find((p) => p.id === id) : null;
    if (fly && poi) this.main.flyTo(poi.lngLat);
  }

  movePoi(id: string, ll: LngLat): void {
    const poi = this.store.project.pois.find((p) => p.id === id);
    if (!poi) return;
    poi.lngLat = ll;
    this.store.emit('pois');
  }

  toggleAddPoi(): void {
    if (this.store.ui.view !== 'explore') return;
    this.store.ui.addingPoi = !this.store.ui.addingPoi;
    this.store.emit('ui');
  }

  private get selectedPoi(): Poi | null {
    const id = this.store.ui.selectedPoiId;
    return id ? this.store.project.pois.find((p) => p.id === id) ?? null : null;
  }

  private deletePoi(id: string): void {
    this.store.project.pois = this.store.project.pois.filter((p) => p.id !== id);
    if (this.store.ui.selectedPoiId === id) this.store.ui.selectedPoiId = null;
    this.store.emit('pois');
  }

  // ------------------------------------------------------------ rendering

  render(): void {
    const ui = this.store.ui;
    const explore = ui.view === 'explore';
    document.body.classList.toggle('view-explore', explore);
    document.body.classList.toggle('adding-poi', explore && ui.addingPoi);
    document.querySelectorAll<HTMLButtonElement>('#compare-switch button').forEach((b) =>
      b.classList.toggle('active', b.dataset.compare === ui.compare),
    );
    $('add-poi-btn').classList.toggle('active', ui.addingPoi);
    $('flip-btn').classList.toggle('active', this.main.areOverlaysHidden);

    // compare target select
    const sel = $<HTMLSelectElement>('compare-target');
    const opts = [
      `<option value="">Сучасна мапа</option>`,
      ...this.store.project.layers.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`),
    ].join('');
    if (sel.dataset.opts !== opts) {
      sel.innerHTML = opts;
      sel.dataset.opts = opts;
    }
    if (ui.compareLayerId && !this.store.project.layers.some((l) => l.id === ui.compareLayerId)) ui.compareLayerId = '';
    sel.value = ui.compareLayerId;
    sel.disabled = ui.compare === 'overlay';

    this.syncCompare();
    this.main.syncPois();
    if (!explore) return;
    this.renderLayers();
    this.renderCategories();
    this.renderPoiList();
    this.renderEditor();
  }

  private renderLayers(): void {
    const ul = $('explore-layers');
    const layers = [...this.store.project.layers].reverse();
    if (!layers.length) {
      ul.innerHTML = '<li class="muted small">Ще немає карт.</li>';
      return;
    }
    // keep sliders alive while dragging: only rebuild when structure changes
    const key = layers.map((l) => `${l.id}:${l.name}:${l.visible}:${this.main.hasOverlay(l.id)}`).join('|');
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = layers
        .map(
          (l) => `<li data-id="${l.id}">
          <input type="checkbox" data-act="vis" ${l.visible ? 'checked' : ''} title="Показувати">
          <span class="name" title="${esc(l.name)}">${esc(l.name)}${this.main.hasOverlay(l.id) ? '' : ' <span class="muted small">(не прив\'язана)</span>'}</span>
          <input type="range" data-act="opacity" min="0" max="1" step="0.05" title="Прозорість">
          <button class="icon-btn" data-act="fit" title="Показати всю карту">⤢</button>
        </li>`,
        )
        .join('');
    }
    ul.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
      const l = this.store.project.layers.find((x) => x.id === li.dataset.id);
      const r = li.querySelector<HTMLInputElement>('[data-act=opacity]');
      if (l && r && document.activeElement !== r) r.value = String(l.opacity);
    });
  }

  private renderCategories(): void {
    const { categories, pois } = this.store.project;
    const counts = new Map<string, number>();
    for (const p of pois) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    $('category-list').innerHTML = categories
      .map(
        (c) => `<li data-id="${c.id}" class="${c.visible ? '' : 'hidden-cat'}">
        <input type="checkbox" data-act="vis" ${c.visible ? 'checked' : ''} title="Показувати / ховати">
        <input type="color" data-act="color" value="${c.color}" title="Колір">
        <span class="name" data-act="rename" title="Двічі клікніть, щоб перейменувати">${esc(c.name)}</span>
        <span class="muted small">${counts.get(c.id) ?? 0}</span>
        <button class="icon-btn" data-act="only" title="Показати лише цю категорію">◉</button>
        <button class="icon-btn danger" data-act="del" title="Видалити категорію">✕</button>
      </li>`,
      )
      .join('');
  }

  private renderPoiList(): void {
    const { pois, categories } = this.store.project;
    const catById = new Map(categories.map((c) => [c.id, c]));
    const q = this.poiFilter.trim().toLowerCase();
    const matches = (p: Poi) => {
      if (!q) return true;
      if (q.startsWith('#')) return p.tags.some((t) => t.toLowerCase().includes(q.slice(1)));
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    };
    const list = pois.filter((p) => catById.get(p.categoryId)?.visible && matches(p));
    $('poi-count').textContent = pois.length ? `(${list.length}/${pois.length})` : '';
    const ul = $('poi-list');
    if (!pois.length) {
      ul.innerHTML = '<li class="muted small empty-row">Натисніть «📍 Мітка», потім клікніть на карті.</li>';
      return;
    }
    ul.innerHTML =
      list
        .map((p) => {
          const c = catById.get(p.categoryId)!;
          const tags = p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ');
          return `<li data-id="${p.id}" class="${p.id === this.store.ui.selectedPoiId ? 'selected' : ''}">
          <span class="dot" style="background:${c.color}"></span>
          <div class="poi-main"><div class="poi-title">${esc(p.title || 'Без назви')}</div>
          <div class="muted small">${esc(c.name)} ${tags}</div></div>
        </li>`;
        })
        .join('') || '<li class="muted small empty-row">Нічого не знайдено.</li>';
  }

  private renderEditor(): void {
    const poi = this.selectedPoi;
    const ed = $('poi-editor');
    ed.classList.toggle('open', !!poi);
    if (!poi) {
      ed.dataset.id = '';
      return;
    }
    const sel = $<HTMLSelectElement>('poi-category');
    sel.innerHTML = this.store.project.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sel.value = poi.categoryId;
    $('poi-coords').textContent = `${poi.lngLat[1].toFixed(6)}, ${poi.lngLat[0].toFixed(6)}`;
    // don't clobber what the user is typing
    if (ed.dataset.id !== poi.id) {
      ed.dataset.id = poi.id;
      $<HTMLInputElement>('poi-title').value = poi.title;
      $<HTMLInputElement>('poi-tags').value = poi.tags.join(', ');
      $<HTMLTextAreaElement>('poi-desc').value = poi.description;
    }
  }

  // ------------------------------------------------------------ controls

  private bindControls(): void {
    const store = this.store;

    document.querySelectorAll<HTMLButtonElement>('#compare-switch button').forEach((b) =>
      b.addEventListener('click', () => this.setCompare(b.dataset.compare as CompareMode)),
    );
    $<HTMLSelectElement>('compare-target').addEventListener('change', (e) => {
      store.ui.compareLayerId = (e.target as HTMLSelectElement).value;
      store.emit('ui');
    });
    $('flip-btn').addEventListener('click', () => this.flip(!this.main.areOverlaysHidden));
    $('add-poi-btn').addEventListener('click', () => this.toggleAddPoi());
    $('explore-panel-toggle').addEventListener('click', () => $('explore-panel').classList.toggle('collapsed'));

    // swipe handle
    const handle = $('swipe-handle');
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = $('map-stage').getBoundingClientRect();
        this.swipeX = Math.max(0.02, Math.min(0.98, (ev.clientX - r.left) / r.width));
        this.applyClip();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => this.applyClip()).observe($('map-stage'));

    // layers
    $('explore-layers').addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const l = this.layerOf(t);
      if (!l) return;
      if (t.dataset.act === 'opacity') {
        l.opacity = Number(t.value);
        store.emit('style');
      }
    });
    $('explore-layers').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const l = this.layerOf(t);
      if (!l) return;
      if (t.dataset.act === 'vis') {
        l.visible = (t as HTMLInputElement).checked;
        store.emit('style');
      } else if (t.dataset.act === 'fit') {
        this.main.fitOverlay(l.id);
      }
    });

    // categories
    $('add-category').addEventListener('click', () => {
      const name = prompt('Назва категорії', 'Нова категорія');
      if (!name) return;
      const used = new Set(store.project.categories.map((c) => c.color));
      const color = CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[store.project.categories.length % CATEGORY_COLORS.length];
      store.project.categories.push({ id: uid(), name, color, visible: true });
      store.emit('pois');
    });
    const catList = $('category-list');
    catList.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const c = this.categoryOf(t);
      if (c && t.dataset.act === 'color') {
        c.color = t.value;
        store.emit('pois');
      }
    });
    catList.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const c = this.categoryOf(t);
      if (!c) return;
      const cats = store.project.categories;
      switch (t.dataset.act) {
        case 'vis':
          c.visible = (t as HTMLInputElement).checked;
          store.emit('pois');
          break;
        case 'only': {
          const onlyThis = cats.every((x) => x.visible === (x.id === c.id));
          cats.forEach((x) => (x.visible = onlyThis ? true : x.id === c.id));
          store.emit('pois');
          break;
        }
        case 'del': {
          if (cats.length <= 1) return this.deps.toast('Має залишитися хоча б одна категорія.');
          const n = store.project.pois.filter((p) => p.categoryId === c.id).length;
          if (n && !confirm(`Видалити категорію «${c.name}» разом з ${n} мітками?`)) return;
          store.project.categories = cats.filter((x) => x.id !== c.id);
          store.project.pois = store.project.pois.filter((p) => p.categoryId !== c.id);
          store.emit('pois');
          break;
        }
      }
    });
    catList.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      const c = this.categoryOf(t);
      if (!c || t.dataset.act !== 'rename') return;
      const name = prompt('Назва категорії', c.name);
      if (name) {
        c.name = name;
        store.emit('pois');
      }
    });

    // POI list
    $<HTMLInputElement>('poi-search').addEventListener('input', (e) => {
      this.poiFilter = (e.target as HTMLInputElement).value;
      this.renderPoiList();
    });
    $('poi-list').addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li?.dataset.id) this.selectPoi(li.dataset.id, true);
    });

    // POI editor
    const edit = (fn: (p: Poi) => void) => {
      const p = this.selectedPoi;
      if (!p) return;
      fn(p);
      store.emit('pois');
    };
    $('poi-title').addEventListener('input', (e) => edit((p) => (p.title = (e.target as HTMLInputElement).value)));
    $('poi-desc').addEventListener('input', (e) => edit((p) => (p.description = (e.target as HTMLTextAreaElement).value)));
    $('poi-tags').addEventListener('input', (e) =>
      edit(
        (p) =>
          (p.tags = (e.target as HTMLInputElement).value
            .split(',')
            .map((t) => t.trim().replace(/^#/, ''))
            .filter(Boolean)),
      ),
    );
    $('poi-category').addEventListener('change', (e) =>
      edit((p) => (p.categoryId = (e.target as HTMLSelectElement).value)),
    );
    $('poi-close').addEventListener('click', () => this.selectPoi(null));
    $('poi-done').addEventListener('click', () => this.selectPoi(null));
    $('poi-delete').addEventListener('click', () => {
      const p = this.selectedPoi;
      if (p && confirm(`Видалити мітку «${p.title}»?`)) this.deletePoi(p.id);
    });
  }

  /** Hide/show all old maps on the main map (quick visual flip). */
  flip(hidden: boolean): void {
    this.main.setOverlaysHidden(hidden);
    $('flip-btn').classList.toggle('active', hidden);
  }

  private layerOf(el: HTMLElement): Layer | undefined {
    const id = el.closest('li')?.dataset.id;
    return this.store.project.layers.find((l) => l.id === id);
  }

  private categoryOf(el: HTMLElement) {
    const id = el.closest('li')?.dataset.id;
    return this.store.project.categories.find((c) => c.id === id);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
