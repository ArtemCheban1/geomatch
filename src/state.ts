/**
 * Project model + a tiny observable store with IndexedDB autosave.
 *
 * A project holds several layers (scanned map sheets). Each layer has its own
 * image, control points and transform, so several sheets can be placed on one
 * map and behave together as one mosaic.
 */
import type { ControlPoint } from './geo/georef';
import type { LngLat } from './geo/mercator';
import type { Pt, TransformKind } from './geo/transforms';

export type BasemapId = 'osm' | 'satellite' | 'hybrid' | 'topo';

export interface Layer {
  id: string;
  name: string;
  image: Blob;
  width: number;
  height: number;
  points: ControlPoint[];
  transform: TransformKind;
  opacity: number;
  visible: boolean;
  /** Optional clip polygon in image pixels — only this part of the image is placed on the map. */
  clip: Pt[] | null;
}

/** Category of user points of interest (colour + visibility). */
export interface Category {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

/** A user point of interest placed on the map in explore mode. */
export interface Poi {
  id: string;
  lngLat: LngLat;
  title: string;
  description: string;
  categoryId: string;
  tags: string[];
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  layers: Layer[];
  categories: Category[];
  pois: Poi[];
  activeLayerId: string | null;
  basemap: BasemapId;
  view?: { center: LngLat; zoom: number };
}

/** A control point being created: one side is clicked, waiting for the other. */
export interface PendingPoint {
  img?: Pt;
  lngLat?: LngLat;
}

/**
 * Tool mode in georeferencing view:
 *  points — place control point pairs
 *  clip   — draw the clip polygon
 *  pan    — look around only
 *  nudge  — drag the overlay on the map to pull it into place (adds TPS points)
 */
export type Mode = 'points' | 'clip' | 'pan' | 'nudge';

/** Top-level app view. */
export type View = 'georef' | 'explore';

/** How old/new maps are compared in explore view. */
export type CompareMode = 'overlay' | 'swipe' | 'lens' | 'side';

export interface UiState {
  view: View;
  mode: Mode;
  compare: CompareMode;
  /** what the compare map shows: '' = modern basemap only, otherwise a layer id */
  compareLayerId: string;
  /** explore view: placing a new POI on next click */
  addingPoi: boolean;
  selectedPoiId: string | null;
  pending: PendingPoint | null;
  selectedPointId: string | null;
  /** clip polygon being drawn */
  clipDraft: Pt[] | null;
}

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function defaultCategories(): Category[] {
  return [
    { id: uid(), name: 'Цікаве місце', color: '#e8590c', visible: true },
    { id: uid(), name: 'Знахідка', color: '#e03131', visible: true },
    { id: uid(), name: 'Будівля / садиба', color: '#1c7ed6', visible: true },
    { id: uid(), name: 'Перевірити', color: '#9c36b5', visible: true },
  ];
}

export function newProject(): Project {
  return {
    id: uid(),
    name: 'Новий проєкт',
    layers: [],
    categories: defaultCategories(),
    pois: [],
    activeLayerId: null,
    basemap: 'hybrid',
  };
}

/** Fill in fields added in later versions so old saved projects keep working. */
export function normalizeProject(p: Project): Project {
  if (!Array.isArray(p.categories) || !p.categories.length) p.categories = defaultCategories();
  if (!Array.isArray(p.pois)) p.pois = [];
  for (const poi of p.pois) {
    poi.tags ??= [];
    poi.description ??= '';
    if (!p.categories.some((c) => c.id === poi.categoryId)) poi.categoryId = p.categories[0].id;
  }
  return p;
}

export function initialUi(): UiState {
  return {
    view: 'georef',
    mode: 'points',
    compare: 'overlay',
    compareLayerId: '',
    addingPoi: false,
    selectedPoiId: null,
    pending: null,
    selectedPointId: null,
    clipDraft: null,
  };
}

type Listener = (reason: ChangeReason) => void;

/**
 * What changed — lets views skip expensive work:
 *  - 'points': control points / transform of the active layer
 *  - 'layers': layer list / images / clip
 *  - 'style':  opacity / visibility / basemap
 *  - 'ui':     selection, pending point, mode
 *  - 'pois':   points of interest / categories
 */
export type ChangeReason = 'points' | 'layers' | 'style' | 'ui' | 'load' | 'pois';

export class Store {
  project: Project = newProject();
  ui: UiState = initialUi();
  private listeners: Listener[] = [];
  private saveTimer: number | undefined;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  emit(reason: ChangeReason): void {
    for (const fn of this.listeners) fn(reason);
    if (reason !== 'ui') this.save();
  }

  get activeLayer(): Layer | null {
    return this.project.layers.find((l) => l.id === this.project.activeLayerId) ?? null;
  }

  updateLayer(id: string, patch: Partial<Layer>, reason: ChangeReason): void {
    const l = this.project.layers.find((x) => x.id === id);
    if (!l) return;
    Object.assign(l, patch);
    this.emit(reason);
  }

  /** Debounced autosave to IndexedDB. */
  save(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveProject(this.project).catch((e) => console.warn('autosave failed', e));
    }, 500);
  }
}

// ---------- IndexedDB persistence ----------

const DB_NAME = 'geomatch';
const STORE = 'projects';
const CURRENT_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(p: Project): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(p, CURRENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadProject(): Promise<Project | null> {
  try {
    const db = await openDb();
    const p = await new Promise<Project | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(CURRENT_KEY);
      req.onsuccess = () => resolve(req.result as Project | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return p ? normalizeProject(p) : null;
  } catch (e) {
    console.warn('could not load project', e);
    return null;
  }
}
