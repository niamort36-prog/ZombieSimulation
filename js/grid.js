/* ═══════════════════════════════════════════════════════
   grid.js — grille de navigation
   Rasterise les polygones/lignes OSM en cellules typées,
   fournit les tests de collision, de vision et de voisinage.
   ═══════════════════════════════════════════════════════ */

import { CFG, T, BLOCK_MOVE, BLOCK_SIGHT } from './config.js';
import { clamp } from './geo.js';

const NDX = [1, -1, 0, 0, 1, 1, -1, -1];
const NDY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Grid {
  constructor(frame, cell = CFG.CELL) {
    this.frame = frame;
    this.cell = cell;
    this.w = Math.max(1, Math.ceil(frame.width  / cell));
    this.h = Math.max(1, Math.ceil(frame.height / cell));
    this.n = this.w * this.h;
    this.flags = new Uint8Array(this.n);
    this.version = 0;           // incrémenté à chaque modif → invalide les flow-fields
  }

  idx(cx, cy) { return cy * this.w + cx; }
  cx(x) { return (x / this.cell) | 0; }
  cy(y) { return (y / this.cell) | 0; }
  inBounds(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }

  flagAt(x, y) {
    const cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return T.BUILDING; // hors zone = mur
    return this.flags[cy * this.w + cx];
  }

  /** Déplacement possible en (x,y) monde ? */
  walkable(x, y) { return (this.flagAt(x, y) & BLOCK_MOVE) === 0; }
  cellWalkable(cx, cy) {
    if (!this.inBounds(cx, cy)) return false;
    return (this.flags[cy * this.w + cx] & BLOCK_MOVE) === 0;
  }
  cellOpaque(cx, cy) {
    if (!this.inBounds(cx, cy)) return true;
    return (this.flags[cy * this.w + cx] & BLOCK_SIGHT) !== 0;
  }

  /** Multiplicateur de vitesse du terrain */
  speedMul(x, y) {
    const f = this.flagAt(x, y);
    if (f & T.RUBBLE) return 0.55;
    if (f & T.ROAD)   return 1.15;
    return 1;
  }

  /* ── Ligne de vue (Bresenham sur cellules) ───────────── */
  hasLOS(x0, y0, x1, y1) {
    const c = this.cell;
    let cx = (x0 / c) | 0, cy = (y0 / c) | 0;
    const ex = (x1 / c) | 0, ey = (y1 / c) | 0;
    let dx = Math.abs(ex - cx), dy = Math.abs(ey - cy);
    const sx = cx < ex ? 1 : -1, sy = cy < ey ? 1 : -1;
    let err = dx - dy, guard = dx + dy + 2;
    while (guard-- > 0) {
      if (cx === ex && cy === ey) return true;
      const e2 = err << 1;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 <  dx) { err += dx; cy += sy; }
      if (cx === ex && cy === ey) return true;
      if (this.cellOpaque(cx, cy)) return false;
    }
    return true;
  }

  /* ══ Composantes connexes ═════════════════════════════
     Un tissu urbain dense contient des cours fermées et des impasses
     ceinturées de murs. Les indexer une fois permet :
       • de rejeter en O(1) un trajet vers une zone inatteignable
         (sinon chaque tentative coûte des milliers d'expansions A*) ;
       • de ne jamais faire apparaître d'unité dans une poche isolée.
     ═════════════════════════════════════════════════════ */
  ensureComponents() {
    if (this.comp && this.compVersion === this.version) return;
    const n = this.n, W = this.w, H = this.h;
    const comp = new Int32Array(n).fill(-1);
    const sizes = [];
    const stack = new Int32Array(n);
    let nc = 0;
    for (let i = 0; i < n; i++) {
      if (comp[i] !== -1 || (this.flags[i] & BLOCK_MOVE)) continue;
      let sp = 0, size = 0;
      comp[i] = nc; stack[sp++] = i;
      while (sp) {
        const c = stack[--sp]; size++;
        const cx = c % W, cy = (c / W) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = cx + NDX[d], ny = cy + NDY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (comp[ni] !== -1 || (this.flags[ni] & BLOCK_MOVE)) continue;
          /* pas de passage en diagonale entre deux angles de murs */
          if (d >= 4 && ((this.flags[cy * W + nx] & BLOCK_MOVE) || (this.flags[ny * W + cx] & BLOCK_MOVE))) continue;
          comp[ni] = nc; stack[sp++] = ni;
        }
      }
      sizes.push(size); nc++;
    }
    let main = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    this.comp = comp;
    this.compSizes = sizes;
    this.mainComp = sizes.length ? main : -1;
    this.compVersion = this.version;
  }

  compAt(x, y) {
    this.ensureComponents();
    const cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (!this.inBounds(cx, cy)) return -1;
    return this.comp[cy * this.w + cx];
  }
  inMainComponent(x, y) { return this.compAt(x, y) === this.mainComp; }

  /** Cellule libre la plus proche appartenant à la zone principale. */
  nearestFreeMain(x, y, maxRing = 80) {
    this.ensureComponents();
    const main = this.mainComp;
    let cx = clamp((x / this.cell) | 0, 0, this.w - 1);
    let cy = clamp((y / this.cell) | 0, 0, this.h - 1);
    if (this.inBounds(cx, cy) && this.comp[cy * this.w + cx] === main) return { x, y };
    for (let r = 1; r <= maxRing; r++) {
      for (let i = -r; i <= r; i++) {
        const cand = [[cx + i, cy - r], [cx + i, cy + r], [cx - r, cy + i], [cx + r, cy + i]];
        for (const [ax, ay] of cand) {
          if (!this.inBounds(ax, ay)) continue;
          if (this.comp[ay * this.w + ax] === main)
            return { x: (ax + 0.5) * this.cell, y: (ay + 0.5) * this.cell };
        }
      }
    }
    return null;
  }

  /* ── Recherche de la cellule libre la plus proche ─────── */
  nearestFree(x, y, maxRing = 40) {
    let cx = clamp((x / this.cell) | 0, 0, this.w - 1);
    let cy = clamp((y / this.cell) | 0, 0, this.h - 1);
    if (this.cellWalkable(cx, cy)) return { x, y };
    for (let r = 1; r <= maxRing; r++) {
      for (let i = -r; i <= r; i++) {
        const cand = [[cx + i, cy - r], [cx + i, cy + r], [cx - r, cy + i], [cx + r, cy + i]];
        for (const [ax, ay] of cand) {
          if (this.cellWalkable(ax, ay))
            return { x: (ax + 0.5) * this.cell, y: (ay + 0.5) * this.cell };
        }
      }
    }
    return null;
  }

  /* ═══ Rasterisation ═══════════════════════════════════ */

  /** Remplit un polygone (scanline, règle even-odd). pts en mètres. */
  fillPolygon(pts, flag) {
    const c = this.cell, N = pts.length;
    if (N < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    let y0 = clamp(Math.floor(minY / c), 0, this.h - 1);
    let y1 = clamp(Math.ceil(maxY / c),  0, this.h - 1);
    const xs = [];
    for (let cy = y0; cy <= y1; cy++) {
      const sy = (cy + 0.5) * c;
      xs.length = 0;
      for (let i = 0, j = N - 1; i < N; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy))
          xs.push(a.x + (sy - a.y) / (b.y - a.y) * (b.x - a.x));
      }
      if (!xs.length) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let cxa = Math.floor(xs[k] / c), cxb = Math.ceil(xs[k + 1] / c) - 1;
        if (cxb < cxa) cxb = cxa;                       // polygone très fin
        cxa = clamp(cxa, 0, this.w - 1); cxb = clamp(cxb, 0, this.w - 1);
        const row = cy * this.w;
        for (let cx = cxa; cx <= cxb; cx++) this.flags[row + cx] |= flag;
      }
    }
    this.version++;
  }

  /** Trace une polyligne épaisse (capsules successives). */
  strokeLine(pts, width, flag) {
    const r = Math.max(this.cell * 0.5, width / 2);
    for (let i = 1; i < pts.length; i++) this.capsule(pts[i - 1], pts[i], r, flag);
    this.version++;
  }

  capsule(a, b, r, flag) {
    const c = this.cell;
    const minX = Math.min(a.x, b.x) - r, maxX = Math.max(a.x, b.x) + r;
    const minY = Math.min(a.y, b.y) - r, maxY = Math.max(a.y, b.y) + r;
    const cx0 = clamp(Math.floor(minX / c), 0, this.w - 1);
    const cx1 = clamp(Math.ceil(maxX / c),  0, this.w - 1);
    const cy0 = clamp(Math.floor(minY / c), 0, this.h - 1);
    const cy1 = clamp(Math.ceil(maxY / c),  0, this.h - 1);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    const r2 = r * r;
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = (cy + 0.5) * c, row = cy * this.w;
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = (cx + 0.5) * c;
        let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = a.x + t * dx - px, qy = a.y + t * dy - py;
        if (qx * qx + qy * qy <= r2) this.flags[row + cx] |= flag;
      }
    }
  }

  /** Disque (explosions : retire les bâtiments, pose des décombres). */
  demolish(x, y, radius) {
    const c = this.cell, r2 = radius * radius;
    const cx0 = clamp(Math.floor((x - radius) / c), 0, this.w - 1);
    const cx1 = clamp(Math.ceil((x + radius) / c),  0, this.w - 1);
    const cy0 = clamp(Math.floor((y - radius) / c), 0, this.h - 1);
    const cy1 = clamp(Math.ceil((y + radius) / c),  0, this.h - 1);
    let touched = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = (cy + 0.5) * c, row = cy * this.w;
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = (cx + 0.5) * c;
        if ((px - x) ** 2 + (py - y) ** 2 > r2) continue;
        const f = this.flags[row + cx];
        if (f & (T.BUILDING | T.WALL | T.FENCE)) {
          this.flags[row + cx] = (f & ~(T.BUILDING | T.WALL | T.FENCE)) | T.RUBBLE;
          touched = true;
        }
      }
    }
    if (touched) this.version++;
    return touched;
  }
}
