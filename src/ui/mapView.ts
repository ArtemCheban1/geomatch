/**
 * The reference map (MapLibre GL) with free raster basemaps, georeferenced
 * overlays and control point markers.
 */
import { maplibregl } from '../maplibre';
import type { ImageSource, StyleSpecification, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mercToLngLat, type LngLat } from '../geo/mercator';
import type { WarpResult } from '../geo/warp';
import type { BasemapId, Layer, Poi, PointCollection, RefLayer, Store } from '../state';
import { featureTitle } from '../refLayers';

export interface MapViewEvents {
  addPoint(ll: LngLat): void;
  movePoint(id: string, ll: LngLat): void;
  select(id: string | null): void;
  viewChanged(center: LngLat, zoom: number): void;
  /** Nudge tool: drag started at `ll` on the overlay; returns the id of the created control point. */
  nudgeStart(ll: LngLat): string | null;
  nudgeMove(id: string, ll: LngLat): void;
  nudgeEnd(id: string, moved: boolean): void;
  /** Click on the map in explore view. */
  exploreClick(ll: LngLat): void;
  poiSelect(id: string): void;
  poiMove(id: string, ll: LngLat): void;
  /** "Add to my marks" pressed in a reference-point popup. */
  refToPoi(title: string, description: string, ll: LngLat): void;
}

/** A no-op implementation, for maps that are view-only (compare map). */
export const NO_EVENTS: MapViewEvents = {
  addPoint: () => {},
  movePoint: () => {},
  select: () => {},
  viewChanged: () => {},
  nudgeStart: () => null,
  nudgeMove: () => {},
  nudgeEnd: () => {},
  exploreClick: () => {},
  poiSelect: () => {},
  poiMove: () => {},
  refToPoi: () => {},
};

/**
 * main    — the working map: overlays of visible layers, control points, POIs
 * compare — second map used for swipe / lens / side-by-side; shows the basemap
 *           and at most one chosen layer (store.ui.compareLayerId)
 */
export type MapRole = 'main' | 'compare';

export const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'hybrid', label: 'Гібрид' },
  { id: 'satellite', label: 'Супутник' },
  { id: 'osm', label: 'Схема (OSM)' },
  { id: 'topo', label: 'Топо' },
];

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles © Esri — Esri, Maxar, Earthstar Geographics, GIS User Community';

const style: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    sat: {
      type: 'raster',
      tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
      attribution: ESRI_ATTR,
    },
    topo: {
      type: 'raster',
      tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap contributors',
    },
    roads: {
      type: 'raster',
      tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
    },
    labels: {
      type: 'raster',
      tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#dde3e8' } },
    { id: 'bm-osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
    { id: 'bm-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
    { id: 'bm-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
    // overlays are inserted here, below the hybrid labels
    { id: 'bm-roads', type: 'raster', source: 'roads', layout: { visibility: 'none' } },
    { id: 'bm-labels', type: 'raster', source: 'labels', layout: { visibility: 'none' } },
  ],
};

const BASEMAP_LAYERS: Record<BasemapId, string[]> = {
  osm: ['bm-osm'],
  satellite: ['bm-sat'],
  hybrid: ['bm-sat', 'bm-roads', 'bm-labels'],
  topo: ['bm-topo'],
};

const OVERLAY_BEFORE = 'bm-roads';

export class MapView {
  readonly map: maplibregl.Map;
  private ready: Promise<void>;
  private markers = new Map<string, { marker: maplibregl.Marker; el: HTMLElement }>();
  private pendingMarker: maplibregl.Marker | null = null;
  private poiMarkers = new Map<string, { marker: maplibregl.Marker; el: HTMLElement }>();
  /** temporarily hide all overlays (flip compare) */
  private overlaysHidden = false;
  private ghostMarker: maplibregl.Marker | null = null;
  /** layer id → bounds of the overlay currently on the map */
  private overlays = new Map<string, WarpResult['bounds']>();
  private labelsOnTop = true;
  /** true once the style has loaded (map.isStyleLoaded() also waits for tiles) */
  private loaded = false;

  constructor(
    container: HTMLElement,
    private store: Store,
    private events: MapViewEvents,
    readonly role: MapRole = 'main',
  ) {
    const view = store.project.view;
    this.map = new maplibregl.Map({
      container,
      style,
      center: view?.center ?? [31.0, 49.0],
      zoom: view?.zoom ?? 5,
      maxZoom: 21,
      attributionControl: { compact: true },
    });
    if (role === 'main') {
      this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
      this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    }
    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.ready = new Promise((resolve) =>
      this.map.once('load', () => {
        this.loaded = true;
        resolve();
      }),
    );

    this.map.on('click', (e: MapMouseEvent) => {
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (this.handleRefClick(e)) return;
      if (this.store.ui.view === 'explore') {
        this.events.exploreClick(ll);
      } else if (this.store.ui.mode === 'points' && this.store.activeLayer) {
        this.events.addPoint(ll);
      } else if (this.store.ui.mode !== 'nudge') {
        this.events.select(null);
      }
    });
    this.bindNudge();
    this.map.on('moveend', () => {
      const c = this.map.getCenter();
      this.events.viewChanged([c.lng, c.lat], this.map.getZoom());
    });

    this.ready.then(() => {
      this.map.addSource('residuals', { type: 'geojson', data: emptyFc() });
      this.map.addLayer({
        id: 'residuals',
        type: 'line',
        source: 'residuals',
        paint: { 'line-color': '#ff2d2d', 'line-width': 2.5 },
      });
      this.setBasemap(this.store.project.basemap);
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  setBasemap(id: BasemapId): void {
    if (!this.loaded) {
      void this.ready.then(() => this.setBasemap(id));
      return;
    }
    const visible = new Set(BASEMAP_LAYERS[id]);
    for (const l of ['bm-osm', 'bm-sat', 'bm-topo', 'bm-roads', 'bm-labels']) {
      const on = visible.has(l) && (this.labelsOnTop || (l !== 'bm-roads' && l !== 'bm-labels'));
      this.map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
    }
  }

  setLabelsVisible(on: boolean): void {
    this.labelsOnTop = on;
    this.setBasemap(this.store.project.basemap);
  }

  // ---------- overlays ----------

  async setOverlay(layer: Layer, res: WarpResult): Promise<void> {
    await this.ready;
    const id = `ov-${layer.id}`;
    const b = res.bounds;
    const coordinates: [LngLat, LngLat, LngLat, LngLat] = [
      mercToLngLat({ x: b.minX, y: b.maxY }),
      mercToLngLat({ x: b.maxX, y: b.maxY }),
      mercToLngLat({ x: b.maxX, y: b.minY }),
      mercToLngLat({ x: b.minX, y: b.minY }),
    ];
    const image = new ImageData(new Uint8ClampedArray(res.data), res.width, res.height);
    const src = this.map.getSource(id) as ImageSource | undefined;
    if (src) {
      src.updateImage({ image, coordinates });
    } else {
      this.map.addSource(id, { type: 'image', coordinates });
      (this.map.getSource(id) as ImageSource).updateImage({ image, coordinates });
      this.map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          paint: {
            'raster-opacity': this.opacityFor(layer),
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
          },
          layout: { visibility: this.isOverlayVisible(layer) ? 'visible' : 'none' },
        },
        OVERLAY_BEFORE,
      );
      this.reorderOverlays();
    }
    this.overlays.set(layer.id, b);
  }

  removeOverlay(layerId: string): void {
    const id = `ov-${layerId}`;
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(id)) this.map.removeSource(id);
    this.overlays.delete(layerId);
  }

  hasOverlay(layerId: string): boolean {
    return this.overlays.has(layerId);
  }

  syncOverlayStyles(): void {
    if (!this.loaded) return;
    for (const l of this.store.project.layers) {
      const id = `ov-${l.id}`;
      if (!this.map.getLayer(id)) continue;
      this.map.setPaintProperty(id, 'raster-opacity', this.opacityFor(l));
      this.map.setLayoutProperty(id, 'visibility', this.isOverlayVisible(l) ? 'visible' : 'none');
    }
    this.reorderOverlays();
  }

  private isOverlayVisible(l: Layer): boolean {
    if (this.role === 'compare') return l.id === this.store.ui.compareLayerId;
    return l.visible && !this.overlaysHidden;
  }

  private opacityFor(l: Layer): number {
    return this.role === 'compare' ? 1 : l.opacity;
  }

  /** Hide / show all overlays at once (quick flip between old and modern map). */
  setOverlaysHidden(hidden: boolean): void {
    this.overlaysHidden = hidden;
    this.syncOverlayStyles();
  }

  get areOverlaysHidden(): boolean {
    return this.overlaysHidden;
  }

  /** Keep overlays in project layer order (last = on top). */
  private reorderOverlays(): void {
    for (const l of this.store.project.layers) {
      const id = `ov-${l.id}`;
      if (this.map.getLayer(id)) this.map.moveLayer(id, OVERLAY_BEFORE);
    }
  }

  fitOverlay(layerId: string): void {
    const b = this.overlays.get(layerId);
    if (!b) return;
    const sw = mercToLngLat({ x: b.minX, y: b.minY });
    const ne = mercToLngLat({ x: b.maxX, y: b.maxY });
    this.map.fitBounds([sw, ne], { padding: 40, duration: 600 });
  }

  // ---------- control points ----------

  syncPoints(residualLines: [LngLat, LngLat][]): void {
    const ui = this.store.ui;
    const georef = ui.view === 'georef' && this.role === 'main';
    const layer = georef ? this.store.activeLayer : null;
    const points = layer?.points ?? [];
    const seen = new Set<string>();
    if (!georef) residualLines = [];

    points.forEach((p, i) => {
      seen.add(p.id);
      let m = this.markers.get(p.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'gcp-marker';
        el.innerHTML = '<span></span>';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.events.select(p.id);
        });
        const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' })
          .setLngLat(p.lngLat)
          .addTo(this.map);
        marker.on('dragstart', () => this.events.select(p.id));
        marker.on('drag', () => {
          const ll = marker.getLngLat();
          this.events.movePoint(p.id, [ll.lng, ll.lat]);
        });
        m = { marker, el };
        this.markers.set(p.id, m);
      }
      m.marker.setLngLat(p.lngLat);
      (m.el.firstElementChild as HTMLElement).textContent = String(i + 1);
      m.el.classList.toggle('selected', p.id === ui.selectedPointId);
      m.el.classList.toggle('disabled', !p.enabled);
    });
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        m.marker.remove();
        this.markers.delete(id);
      }
    }

    // pending point (map side clicked first)
    if (georef && ui.pending?.lngLat) {
      if (!this.pendingMarker) {
        const el = document.createElement('div');
        el.className = 'gcp-marker pending';
        el.innerHTML = '<span></span>';
        this.pendingMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
      }
      (this.pendingMarker.getElement().firstElementChild as HTMLElement).textContent = String(points.length + 1);
      this.pendingMarker.setLngLat(ui.pending.lngLat).addTo(this.map);
    } else {
      this.pendingMarker?.remove();
    }

    const src = this.map.getSource('residuals') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: residualLines.map((coords) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      })),
    });
  }

  setGhost(ll: LngLat | null): void {
    if (!ll || this.store.ui.view !== 'georef') {
      this.ghostMarker?.remove();
      return;
    }
    if (!this.ghostMarker) {
      const el = document.createElement('div');
      el.className = 'gcp-marker ghost';
      el.innerHTML = '<span>?</span>';
      this.ghostMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    this.ghostMarker.setLngLat(ll).addTo(this.map);
  }

  // ---------- nudge tool ----------

  /**
   * Drag on the map pulls the overlay: the spot under the cursor at mousedown
   * becomes a new control point whose map position follows the cursor.
   */
  private bindNudge(): void {
    let dragging: { id: string; moved: boolean } | null = null;
    const canvas = this.map.getCanvasContainer();

    this.map.on('mousedown', (e: MapMouseEvent) => {
      const ui = this.store.ui;
      if (this.role !== 'main' || ui.view !== 'georef' || ui.mode !== 'nudge' || e.originalEvent.button !== 0) return;
      const id = this.events.nudgeStart([e.lngLat.lng, e.lngLat.lat]);
      if (!id) return;
      e.preventDefault(); // keep the map from panning
      dragging = { id, moved: false };
      canvas.style.cursor = 'grabbing';
    });
    this.map.on('mousemove', (e: MapMouseEvent) => {
      if (!dragging) {
        const ui = this.store.ui;
        canvas.style.cursor = ui.view === 'georef' && ui.mode === 'nudge' ? 'grab' : '';
        return;
      }
      dragging.moved = true;
      this.events.nudgeMove(dragging.id, [e.lngLat.lng, e.lngLat.lat]);
    });
    const end = () => {
      if (!dragging) return;
      const d = dragging;
      dragging = null;
      canvas.style.cursor = '';
      this.events.nudgeEnd(d.id, d.moved);
    };
    this.map.on('mouseup', end);
    window.addEventListener('mouseup', end);
  }

  // ---------- reference layers (heritage databases) ----------

  private refIds = new Set<string>();
  private popup: maplibregl.Popup | null = null;

  /** Show / update / hide a reference point layer. */
  setRefLayer(l: RefLayer, data: PointCollection | null): void {
    if (!this.loaded) {
      void this.ready.then(() => this.setRefLayer(l, data));
      return;
    }
    const id = `ref-${l.id}`;
    const src = this.map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (!data) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }
    if (!src) {
      this.map.addSource(id, { type: 'geojson', data: data as any });
      this.map.addLayer({
        id,
        type: 'circle',
        source: id,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 10, 5, 14, 7],
          'circle-color': l.color,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.9,
        },
      });
      this.refIds.add(id);
      this.map.on('mouseenter', id, () => {
        if (this.refClickable()) this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', id, () => (this.map.getCanvas().style.cursor = ''));
    } else if ((src as any)._refData !== data) {
      src.setData(data as any);
    }
    (this.map.getSource(id) as any)._refData = data;
    this.map.setPaintProperty(id, 'circle-color', l.color);
    this.map.setLayoutProperty(id, 'visibility', l.visible ? 'visible' : 'none');
  }

  removeRefLayer(layerId: string): void {
    const id = `ref-${layerId}`;
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(id)) this.map.removeSource(id);
    this.refIds.delete(id);
  }

  /** Reference points answer clicks in explore view and in the "look around" tool. */
  private refClickable(): boolean {
    const ui = this.store.ui;
    return this.role === 'main' && (ui.view === 'explore' ? !ui.addingPoi : ui.mode === 'pan');
  }

  private handleRefClick(e: MapMouseEvent): boolean {
    if (!this.refClickable() || !this.refIds.size) return false;
    const layers = [...this.refIds].filter((id) => this.map.getLayer(id));
    const hit = this.map.queryRenderedFeatures(
      [
        [e.point.x - 6, e.point.y - 6],
        [e.point.x + 6, e.point.y + 6],
      ],
      { layers },
    )[0];
    if (!hit) return false;
    const props = (hit.properties ?? {}) as Record<string, unknown>;
    const coords = (hit.geometry as any).coordinates as LngLat;
    const refLayer = this.store.project.refLayers.find((l) => `ref-${l.id}` === hit.layer.id);
    this.showRefPopup(props, coords, refLayer);
    return true;
  }

  private showRefPopup(props: Record<string, unknown>, ll: LngLat, layer?: RefLayer): void {
    const title = featureTitle(props);
    const el = document.createElement('div');
    el.className = 'ref-popup';
    const rows = Object.entries(props)
      .filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !/^(title|name|url|link)$/i.test(k))
      .slice(0, 14)
      .map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(String(v))}</td></tr>`)
      .join('');
    const url = [props.url, props.link].find((v) => typeof v === 'string' && /^https?:\/\//.test(v)) as string | undefined;
    el.innerHTML = `
      <div class="ref-popup-src" style="color:${layer?.color ?? '#495057'}">${escHtml(layer?.name ?? '')}</div>
      <div class="ref-popup-title">${escHtml(title)}</div>
      ${rows ? `<table>${rows}</table>` : ''}
      <div class="ref-popup-actions">
        ${url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener">Відкрити запис ↗</a>` : '<span></span>'}
        <button class="btn small" data-act="to-poi">📍 У мої мітки</button>
      </div>`;
    el.querySelector('[data-act=to-poi]')!.addEventListener('click', () => {
      const description = Object.entries(props)
        .filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !/^(title|name)$/i.test(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      this.events.refToPoi(title, `${description}${layer?.attribution ? `\n\nДжерело: ${layer.attribution}` : ''}`, ll);
      this.popup?.remove();
    });
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ maxWidth: '340px', offset: 8 }).setLngLat(ll).setDOMContent(el).addTo(this.map);
  }

  // ---------- points of interest ----------

  syncPois(): void {
    const { pois, categories } = this.store.project;
    const ui = this.store.ui;
    const show = this.role === 'main' && ui.view === 'explore';
    const catById = new Map(categories.map((c) => [c.id, c]));
    const seen = new Set<string>();
    if (show) {
      for (const poi of pois) {
        const cat = catById.get(poi.categoryId);
        if (!cat?.visible) continue;
        seen.add(poi.id);
        let m = this.poiMarkers.get(poi.id);
        if (!m) m = this.createPoiMarker(poi);
        m.marker.setLngLat(poi.lngLat);
        m.el.style.setProperty('--pin', cat.color);
        (m.el.querySelector('.poi-label') as HTMLElement).textContent = poi.title;
        m.el.classList.toggle('selected', poi.id === ui.selectedPoiId);
      }
    }
    for (const [id, m] of this.poiMarkers) {
      if (!seen.has(id)) {
        m.marker.remove();
        this.poiMarkers.delete(id);
      }
    }
  }

  private createPoiMarker(poi: Poi): { marker: maplibregl.Marker; el: HTMLElement } {
    const el = document.createElement('div');
    el.className = 'poi-marker';
    el.innerHTML = `<svg viewBox="0 0 24 32" width="26" height="34"><path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z" fill="var(--pin)" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" fill="#fff"/></svg><span class="poi-label"></span>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.events.poiSelect(poi.id);
    });
    const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
      .setLngLat(poi.lngLat)
      .addTo(this.map);
    marker.on('dragstart', () => this.events.poiSelect(poi.id));
    marker.on('dragend', () => {
      const ll = marker.getLngLat();
      this.events.poiMove(poi.id, [ll.lng, ll.lat]);
    });
    const m = { marker, el };
    this.poiMarkers.set(poi.id, m);
    return m;
  }

  flyTo(ll: LngLat, minZoom = 15): void {
    this.map.flyTo({ center: ll, zoom: Math.max(this.map.getZoom(), minZoom), duration: 800 });
  }

  panTo(ll: LngLat): void {
    this.map.easeTo({ center: ll, duration: 400 });
  }

  flyToBbox(bbox: [number, number, number, number]): void {
    this.map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 20, maxZoom: 16, duration: 1200 },
    );
  }
}

function emptyFc(): { type: 'FeatureCollection'; features: [] } {
  return { type: 'FeatureCollection', features: [] };
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
