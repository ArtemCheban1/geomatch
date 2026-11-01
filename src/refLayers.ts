/**
 * Reference point layers (heritage registers etc.): built-in manifest,
 * on-demand loading and parsing of GeoJSON / CSV files.
 */
import { uid, type PointCollection, type Project, type RefLayer } from './state';

const MANIFEST_URL = 'data/heritage/index.json';

interface ManifestEntry {
  id: string;
  name: string;
  color: string;
  url: string;
  attribution?: string;
}

export type RefStatus = { state: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; count?: number; message?: string };

const cache = new Map<string, PointCollection>();
const status = new Map<string, RefStatus>();

export function refStatus(l: RefLayer): RefStatus {
  if (l.source === 'file') return { state: 'ready', count: l.data?.features.length ?? 0 };
  return status.get(l.id) ?? { state: 'idle' };
}

/** Add built-in layers from the manifest that the project doesn't know yet. */
export async function mergeManifest(p: Project): Promise<boolean> {
  let entries: ManifestEntry[];
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) return false;
    entries = await res.json();
  } catch {
    return false;
  }
  let changed = false;
  for (const e of entries) {
    const existing = p.refLayers.find((l) => l.id === e.id);
    if (existing) {
      // keep user choices (visibility, colour), refresh the rest
      existing.url = e.url;
      existing.attribution = e.attribution;
      existing.source = 'builtin';
    } else {
      p.refLayers.push({ ...e, visible: false, source: 'builtin' });
      changed = true;
    }
  }
  return changed;
}

/** Data of a layer, fetching built-in data on first use. */
export async function loadRefData(l: RefLayer): Promise<PointCollection | null> {
  if (l.source === 'file') return l.data ?? null;
  const hit = cache.get(l.id);
  if (hit) return hit;
  if (!l.url) return null;
  const st = status.get(l.id)?.state;
  if (st === 'missing' || st === 'error' || st === 'loading') return null;
  status.set(l.id, { state: 'loading' });
  try {
    const res = await fetch(l.url);
    if (res.status === 404) {
      status.set(l.id, { state: 'missing', message: 'Дані ще не завантажені в застосунок' });
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = normalizeCollection(await res.json());
    cache.set(l.id, fc);
    status.set(l.id, { state: 'ready', count: fc.features.length });
    return fc;
  } catch (e) {
    // Vite's dev server answers unknown paths with index.html → JSON parse error
    const missing = e instanceof SyntaxError;
    status.set(l.id, missing ? { state: 'missing', message: 'Дані ще не завантажені в застосунок' } : { state: 'error', message: (e as Error).message });
    return null;
  }
}

// ---------------------------------------------------------------- parsing

function normalizeCollection(json: any): PointCollection {
  const feats: any[] = json?.type === 'FeatureCollection' ? json.features : Array.isArray(json) ? json : [];
  return {
    type: 'FeatureCollection',
    features: feats
      .filter((f) => f?.geometry?.type === 'Point' && f.geometry.coordinates?.every?.((v: unknown) => Number.isFinite(v)))
      .map((f) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[1]] as [number, number] },
        properties: f.properties ?? {},
      })),
  };
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

const LAT_KEYS = ['lat', 'latitude', 'latitudine', 'y', 'широта'];
const LNG_KEYS = ['lng', 'lon', 'long', 'longitude', 'longitudine', 'x', 'довгота'];

/** CSV with a header row and latitude/longitude columns (WGS84, decimal degrees). */
export function parseCsvPoints(text: string): PointCollection {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV порожній.');
  const sep = [';', '\t', ','].find((s) => lines[0].includes(s)) ?? ',';
  const header = splitCsvLine(lines[0], sep);
  const lower = header.map((h) => h.toLowerCase());
  const latI = lower.findIndex((h) => LAT_KEYS.includes(h));
  const lngI = lower.findIndex((h) => LNG_KEYS.includes(h));
  if (latI < 0 || lngI < 0) throw new Error('У CSV немає колонок lat / lon (або latitude / longitude).');
  const num = (v: string) => Number(v.replace(',', '.'));
  const features: PointCollection['features'] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, sep);
    const lat = num(cells[latI] ?? '');
    const lng = num(cells[lngI] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const properties: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (i !== latI && i !== lngI && cells[i]) properties[h] = cells[i];
    });
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties });
  }
  return { type: 'FeatureCollection', features };
}

export function parseRefFile(name: string, text: string): PointCollection {
  const fc = /\.(csv|txt)$/i.test(name) ? parseCsvPoints(text) : normalizeCollection(JSON.parse(text));
  if (!fc.features.length) throw new Error('У файлі не знайдено точок.');
  return fc;
}

export function newFileLayer(name: string, data: PointCollection, color: string): RefLayer {
  return { id: uid(), name: name.replace(/\.[^.]+$/, ''), color, visible: true, source: 'file', data };
}

// ---------------------------------------------------------------- display helpers

const TITLE_KEYS = ['title', 'name', 'nume', 'denumire', 'назва', 'site', 'sit'];

export function featureTitle(props: Record<string, unknown>): string {
  for (const k of Object.keys(props)) {
    if (TITLE_KEYS.includes(k.toLowerCase()) && props[k]) return String(props[k]);
  }
  return 'Об\'єкт';
}
