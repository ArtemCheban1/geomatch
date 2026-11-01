/**
 * The reference map (MapLibre GL) with free raster basemaps, georeferenced
 * overlays and control point markers.
 */
import { maplibregl } from '../maplibre';
import type { ImageSource, StyleSpecification, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mercToLngLat, type LngLat } from '../geo/mercator';
import type { WarpResult } from '../geo/warp';
import type { BasemapId, Layer, Store } from '../state';

export interface MapViewEvents {
  addPoint(ll: LngLat): void;
  movePoint(id: string, ll: LngLat): void;
  select(id: string | null): void;
  viewChanged(center: LngLat, zoom: number): void;
}

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
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.ready = new Promise((resolve) =>
      this.map.once('load', () => {
        this.loaded = true;
        resolve();
      }),
    );

    this.map.on('click', (e: MapMouseEvent) => {
      if (this.store.ui.mode === 'points' && this.store.activeLayer) {
        this.events.addPoint([e.lngLat.lng, e.lngLat.lat]);
      } else {
        this.events.select(null);
      }
    });
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
          paint: { 'raster-opacity': layer.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          layout: { visibility: layer.visible ? 'visible' : 'none' },
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
      this.map.setPaintProperty(id, 'raster-opacity', l.opacity);
      this.map.setLayoutProperty(id, 'visibility', l.visible ? 'visible' : 'none');
    }
    this.reorderOverlays();
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
    const layer = this.store.activeLayer;
    const ui = this.store.ui;
    const points = layer?.points ?? [];
    const seen = new Set<string>();

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
    if (ui.pending?.lngLat) {
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
    if (!ll) {
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
