/**
 * MapLibre entry point. MapLibre ≥ 6 loads its Web Worker relative to its own
 * module URL, which breaks once Vite bundles it — so bundle the worker
 * explicitly and point MapLibre at it.
 */
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);

export { maplibregl };
