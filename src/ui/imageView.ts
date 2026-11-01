/**
 * Pan/zoom viewer for the scanned map image, with control point markers.
 */
import type { Pt } from '../geo/transforms';
import type { Layer, Store } from '../state';

export interface ImageViewEvents {
  addPoint(p: Pt): void;
  movePoint(id: string, p: Pt): void;
  select(id: string | null): void;
  clipClick(p: Pt): void;
  clipFinish(): void;
}

const HIT_RADIUS = 12;

export class ImageView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bitmap: ImageBitmap | null = null;
  private bitmapBlob: Blob | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private ghost: Pt | null = null;
  private hover: Pt | null = null;
  private drag:
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | { type: 'point'; id: string; moved: boolean }
    | null = null;
  private raf = 0;

  constructor(
    private container: HTMLElement,
    private store: Store,
    private events: ImageViewEvents,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'image-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindEvents();
  }

  private get layer(): Layer | null {
    return this.store.activeLayer;
  }

  async syncLayer(): Promise<void> {
    const layer = this.layer;
    if (!layer) {
      this.bitmap?.close();
      this.bitmap = null;
      this.bitmapBlob = null;
      this.requestRender();
      return;
    }
    if (layer.image !== this.bitmapBlob) {
      this.bitmapBlob = layer.image;
      const bmp = await createImageBitmap(layer.image);
      if (this.bitmapBlob !== layer.image) {
        bmp.close();
        return;
      }
      this.bitmap?.close();
      this.bitmap = bmp;
      this.fit();
    }
    this.requestRender();
  }

  /** Fit the whole image into the viewport. */
  fit(): void {
    if (!this.bitmap) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.scale = Math.min(w / this.bitmap.width, h / this.bitmap.height) * 0.95;
    this.ox = (w - this.bitmap.width * this.scale) / 2;
    this.oy = (h - this.bitmap.height * this.scale) / 2;
    this.requestRender();
  }

  /** Pan so that `p` is in the centre (keeps zoom, zooms in if very far out). */
  centerOn(p: Pt): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.ox = w / 2 - p.x * this.scale;
    this.oy = h / 2 - p.y * this.scale;
    this.requestRender();
  }

  setGhost(p: Pt | null): void {
    this.ghost = p;
    this.requestRender();
  }

  zoomBy(f: number): void {
    const w = this.container.clientWidth / 2;
    const h = this.container.clientHeight / 2;
    this.zoomAt(w, h, f);
  }

  private zoomAt(sx: number, sy: number, f: number): void {
    const ns = Math.max(0.01, Math.min(64, this.scale * f));
    const k = ns / this.scale;
    this.ox = sx - (sx - this.ox) * k;
    this.oy = sy - (sy - this.oy) * k;
    this.scale = ns;
    this.requestRender();
  }

  private toImage(sx: number, sy: number): Pt {
    return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
  }

  private toScreen(p: Pt): Pt {
    return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy };
  }

  private hitPoint(sx: number, sy: number): string | null {
    const layer = this.layer;
    if (!layer) return null;
    let best: string | null = null;
    let bestD = HIT_RADIUS;
    for (const p of layer.points) {
      const s = this.toScreen(p.img);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const hit = e.button === 0 && this.store.ui.mode !== 'clip' ? this.hitPoint(sx, sy) : null;
      if (hit) {
        this.drag = { type: 'point', id: hit, moved: false };
        this.events.select(hit);
      } else {
        this.drag = { type: 'pan', sx, sy, ox: this.ox, oy: this.oy, moved: false };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      this.hover = this.toImage(sx, sy);
      const d = this.drag;
      if (d?.type === 'pan') {
        if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true;
        this.ox = d.ox + sx - d.sx;
        this.oy = d.oy + sy - d.sy;
      } else if (d?.type === 'point') {
        d.moved = true;
        this.events.movePoint(d.id, this.clampToImage(this.toImage(sx, sy)));
      }
      c.style.cursor = d?.type === 'pan' && d.moved ? 'grabbing' : this.hitPoint(sx, sy) ? 'move' : 'crosshair';
      this.requestRender();
    });

    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.type !== 'pan' || d.moved || e.button !== 0) return;
      const r = c.getBoundingClientRect();
      const p = this.toImage(e.clientX - r.left, e.clientY - r.top);
      if (!this.bitmap) return;
      const mode = this.store.ui.mode;
      if (mode === 'clip') {
        this.events.clipClick(this.clampToImage(p));
        return;
      }
      if (p.x < 0 || p.y < 0 || p.x > this.bitmap.width || p.y > this.bitmap.height) {
        this.events.select(null);
        return;
      }
      if (mode === 'points') this.events.addPoint(p);
      else this.events.select(null);
    });

    c.addEventListener('dblclick', (e) => {
      if (this.store.ui.mode === 'clip') {
        e.preventDefault();
        this.events.clipFinish();
      }
    });

    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.requestRender();
    });
  }

  private clampToImage(p: Pt): Pt {
    if (!this.bitmap) return p;
    return {
      x: Math.max(0, Math.min(this.bitmap.width, p.x)),
      y: Math.max(0, Math.min(this.bitmap.height, p.y)),
    };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.requestRender();
  }

  requestRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layer = this.layer;
    if (!this.bitmap || !layer) return;

    ctx.imageSmoothingEnabled = this.scale < 3;
    ctx.drawImage(this.bitmap, this.ox, this.oy, this.bitmap.width * this.scale, this.bitmap.height * this.scale);

    this.renderClip(layer);

    const ui = this.store.ui;
    // residual-free point markers
    layer.points.forEach((p, i) => {
      const s = this.toScreen(p.img);
      drawMarker(ctx, s, String(i + 1), {
        fill: p.enabled ? '#e8590c' : '#868e96',
        selected: p.id === ui.selectedPointId,
      });
    });
    if (ui.pending?.img) {
      drawMarker(ctx, this.toScreen(ui.pending.img), String(layer.points.length + 1), { fill: '#1c7ed6', selected: true });
    }
    if (this.ghost) {
      drawMarker(ctx, this.toScreen(this.ghost), '?', { fill: 'rgba(28,126,214,0.35)', dashed: true });
    }
  }

  private renderClip(layer: Layer): void {
    const ctx = this.ctx;
    const ui = this.store.ui;
    const poly = ui.mode === 'clip' && ui.clipDraft ? ui.clipDraft : layer.clip;
    if (!poly || poly.length === 0) return;
    const pts = poly.map((p) => this.toScreen(p));
    const closed = poly === layer.clip;

    if (closed && pts.length >= 3 && this.bitmap) {
      // dim everything outside the clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.ox, this.oy, this.bitmap.width * this.scale, this.bitmap.height * this.scale);
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fab005';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (closed) ctx.closePath();
    else if (this.hover) {
      const h = this.toScreen(this.hover);
      ctx.lineTo(h.x, h.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fab005';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  label: string,
  o: { fill: string; selected?: boolean; dashed?: boolean },
): void {
  ctx.save();
  // crosshair for precise placement
  ctx.strokeStyle = o.selected ? '#fff' : 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p.x - 14, p.y);
  ctx.lineTo(p.x + 14, p.y);
  ctx.moveTo(p.x, p.y - 14);
  ctx.lineTo(p.x, p.y + 14);
  ctx.stroke();
  ctx.strokeStyle = o.fill;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(p.x, p.y, o.selected ? 9 : 7, 0, Math.PI * 2);
  ctx.lineWidth = o.selected ? 3 : 2;
  ctx.strokeStyle = o.selected ? '#fff' : o.fill;
  if (o.dashed) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = 'bold 12px system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = o.fill;
  roundRect(ctx, p.x + 9, p.y - 22, tw + 10, 17, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, p.x + 14, p.y - 9);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
