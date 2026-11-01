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

export interface Project {
  id: string;
  name: string;
  layers: Layer[];
  activeLayerId: string | null;
  basemap: BasemapId;
  view?: { center: LngLat; zoom: number };
}

/** A control point being created: one side is clicked, waiting for the other. */
export interface PendingPoint {
  img?: Pt;
  lngLat?: LngLat;
}

export type Mode = 'points' | 'clip' | 'pan';

export interface UiState {
  mode: Mode;
  pending: PendingPoint | null;
  selectedPointId: string | null;
  /** clip polygon being drawn */
  clipDraft: Pt[] | null;
}

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newProject(): Project {
  return { id: uid(), name: 'Новий проєкт', layers: [], activeLayerId: null, basemap: 'hybrid' };
}

type Listener = (reason: ChangeReason) => void;

/**
 * What changed — lets views skip expensive work:
 *  - 'points': control points / transform of the active layer
 *  - 'layers': layer list / images / clip
 *  - 'style':  opacity / visibility / basemap
 *  - 'ui':     selection, pending point, mode
 */
export type ChangeReason = 'points' | 'layers' | 'style' | 'ui' | 'load';

export class Store {
  project: Project = newProject();
  ui: UiState = { mode: 'points', pending: null, selectedPointId: null, clipDraft: null };
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
    return p ?? null;
  } catch (e) {
    console.warn('could not load project', e);
    return null;
  }
}
