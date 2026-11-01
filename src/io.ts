/** Import / export: project files, QGIS GCP files, georeferenced PNG + world file. */
import type { ControlPoint, Georef } from './geo/georef';
import type { WarpResult } from './geo/warp';
import type { Layer, Project } from './state';
import { uid } from './state';

export function download(name: string, data: Blob | string, type = 'application/octet-stream'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'map';
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

// ---------- full project (.geomatch.json, images embedded) ----------

interface ProjectFile {
  format: 'geomatch-project';
  version: 1;
  project: Omit<Project, 'layers'> & { layers: (Omit<Layer, 'image'> & { image: string })[] };
}

export async function exportProject(p: Project): Promise<void> {
  const file: ProjectFile = {
    format: 'geomatch-project',
    version: 1,
    project: {
      ...p,
      layers: await Promise.all(p.layers.map(async (l) => ({ ...l, image: await blobToDataUrl(l.image) }))),
    },
  };
  download(`${baseName(p.name)}.geomatch.json`, JSON.stringify(file), 'application/json');
}

export async function importProject(text: string): Promise<Project> {
  const f = JSON.parse(text) as ProjectFile;
  if (f.format !== 'geomatch-project') throw new Error('Це не файл проєкту Геомач.');
  const layers = await Promise.all(
    f.project.layers.map(async (l) => ({ ...l, image: await dataUrlToBlob(l.image) }) as Layer),
  );
  return { ...f.project, layers };
}

// ---------- QGIS georeferencer .points ----------

/**
 * QGIS Georeferencer GCP file. Source Y is negative (QGIS uses -row).
 * Map coordinates are written in EPSG:4326.
 */
export function exportQgisPoints(layer: Layer, g: Georef | null): string {
  const lines = [
    '#CRS: GEOGCRS["WGS 84",ENSEMBLE["World Geodetic System 1984 ensemble"],ID["EPSG",4326]]',
    'mapX,mapY,sourceX,sourceY,enable,dX,dY,residual',
  ];
  for (const p of layer.points) {
    const r = g?.residuals[p.id];
    lines.push(
      [
        p.lngLat[0].toFixed(9),
        p.lngLat[1].toFixed(9),
        p.img.x.toFixed(4),
        (-p.img.y).toFixed(4),
        p.enabled ? 1 : 0,
        (r?.dx ?? 0).toFixed(4),
        (r?.dy ?? 0).toFixed(4),
        (r?.error ?? 0).toFixed(4),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function importQgisPoints(text: string): ControlPoint[] {
  const points: ControlPoint[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('mapX')) continue;
    const [mapX, mapY, sx, sy, en] = line.split(/[,\t]/).map(Number);
    if ([mapX, mapY, sx, sy].some((v) => !Number.isFinite(v))) continue;
    points.push({ id: uid(), lngLat: [mapX, mapY], img: { x: sx, y: -sy }, enabled: en !== 0 });
  }
  return points;
}

// ---------- georeferenced raster ----------

/** EPSG:3857 WKT for the .prj sidecar. */
const PRJ_3857 =
  'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';

export async function exportGeoPng(name: string, res: WarpResult): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = res.width;
  canvas.height = res.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), 0, 0);
  const png = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
  const b = res.bounds;
  const px = (b.maxX - b.minX) / res.width;
  const py = (b.maxY - b.minY) / res.height;
  // world file: pixel size x, rotation, rotation, -pixel size y, centre of upper-left pixel
  const pgw = [px, 0, 0, -py, b.minX + px / 2, b.maxY - py / 2].map((v) => v.toFixed(10)).join('\n') + '\n';
  const base = baseName(name);
  download(`${base}.png`, png);
  await new Promise((r) => setTimeout(r, 300));
  download(`${base}.pgw`, pgw, 'text/plain');
  await new Promise((r) => setTimeout(r, 300));
  download(`${base}.prj`, PRJ_3857, 'text/plain');
}
