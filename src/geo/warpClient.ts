/** Promise-based wrapper around the warp Web Worker. */
import type { WarpRequest, WarpResult } from './warp';
import type { Pt } from './transforms';

export const PREVIEW_SOURCE_SIZE = 4096;

export class WarpClient {
  private worker = new Worker(new URL('./warp.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: WarpResult) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
  }

  async setSource(key: string, image: Blob, clip: Pt[] | null, maxSourceSize = PREVIEW_SOURCE_SIZE): Promise<void> {
    const bitmap = await createImageBitmap(image);
    this.worker.postMessage({ type: 'source', key, bitmap, maxSourceSize, clip }, [bitmap]);
  }

  setClip(key: string, clip: Pt[] | null): void {
    this.worker.postMessage({ type: 'clip', key, clip });
  }

  drop(key: string): void {
    this.worker.postMessage({ type: 'drop', key });
  }

  warp(key: string, req: WarpRequest): Promise<WarpResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'warp', id, key, req });
    });
  }
}
