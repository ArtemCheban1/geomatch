/** Spherical Web Mercator (EPSG:3857) helpers. */
export const R = 6378137;
export const MAX_LAT = 85.0511287798066;

export type LngLat = [number, number];

export function lngLatToMerc([lng, lat]: LngLat): { x: number; y: number } {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return {
    x: (R * lng * Math.PI) / 180,
    y: R * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
  };
}

export function mercToLngLat(p: { x: number; y: number }): LngLat {
  return [(p.x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(p.y / R)) - Math.PI / 2) * (180 / Math.PI)];
}

/** Ground metres per Mercator metre at a given latitude. */
export function mercScale(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}
