/* ═══════════════════════════════════════════════════════
   spatial.js — grille de hachage spatial
   Requêtes de voisinage en O(1) amorti pour la perception,
   la séparation entre agents et la résolution des tirs.
   ═══════════════════════════════════════════════════════ */

export class SpatialHash {
  constructor(width, height, cell = 16) {
    this.cell = cell;
    this.w = Math.max(1, Math.ceil(width / cell));
    this.h = Math.max(1, Math.ceil(height / cell));
    this.buckets = new Array(this.w * this.h);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear() {
    for (let i = 0; i < this.buckets.length; i++)
      if (this.buckets[i].length) this.buckets[i].length = 0;
  }

  insert(e) {
    let cx = (e.x / this.cell) | 0, cy = (e.y / this.cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.w) cx = this.w - 1;
    if (cy < 0) cy = 0; else if (cy >= this.h) cy = this.h - 1;
    this.buckets[cy * this.w + cx].push(e);
  }

  /** Applique `fn` à toutes les entités dans le rayon r autour de (x,y). */
  query(x, y, r, fn) {
    const c = this.cell;
    let x0 = ((x - r) / c) | 0, x1 = ((x + r) / c) | 0;
    let y0 = ((y - r) / c) | 0, y1 = ((y + r) / c) | 0;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 >= this.w) x1 = this.w - 1;
    if (y1 >= this.h) y1 = this.h - 1;
    const r2 = r * r;
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.w;
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets[row + cx];
        for (let i = 0; i < b.length; i++) {
          const e = b[i];
          const dx = e.x - x, dy = e.y - y;
          if (dx * dx + dy * dy <= r2) fn(e, dx * dx + dy * dy);
        }
      }
    }
  }

  /** Entité la plus proche satisfaisant `filter`. */
  nearest(x, y, r, filter) {
    let best = null, bestD = Infinity;
    this.query(x, y, r, (e, d2) => {
      if (d2 < bestD && filter(e)) { bestD = d2; best = e; }
    });
    return best ? { e: best, d: Math.sqrt(bestD) } : null;
  }
}
