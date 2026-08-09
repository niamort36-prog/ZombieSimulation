/* ═══════════════════════════════════════════════════════
   geo.js — projection locale lat/lon <-> mètres
   Plan tangent equirectangulaire centré sur la zone :
   erreur < 0.1 % sur quelques kilomètres, largement suffisant
   et beaucoup plus rapide qu'une vraie projection.
   x → Est (m)   |   y → Sud (m)   (y croissant = vers le bas de l'écran)
   ═══════════════════════════════════════════════════════ */

const R = 6378137;
const D2R = Math.PI / 180;

export class Frame {
  /** @param {{south:number,west:number,north:number,east:number}} bounds */
  constructor(bounds) {
    this.b = bounds;
    this.lat0 = bounds.north;                    // origine = coin Nord-Ouest
    this.lon0 = bounds.west;
    const midLat = (bounds.north + bounds.south) / 2;
    this.mPerDegLat = D2R * R;                            // ≈ 111320
    this.mPerDegLon = D2R * R * Math.cos(midLat * D2R);
    this.width  = (bounds.east  - bounds.west)  * this.mPerDegLon;
    this.height = (bounds.north - bounds.south) * this.mPerDegLat;
  }

  toWorld(lat, lon) {
    return {
      x: (lon - this.lon0) * this.mPerDegLon,
      y: (this.lat0 - lat) * this.mPerDegLat,
    };
  }
  toWorldXY(lat, lon, out) {
    out.x = (lon - this.lon0) * this.mPerDegLon;
    out.y = (this.lat0 - lat) * this.mPerDegLat;
    return out;
  }
  toLatLng(x, y) {
    return [this.lat0 - y / this.mPerDegLat, this.lon0 + x / this.mPerDegLon];
  }
  contains(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  get areaKm2() { return (this.width * this.height) / 1e6; }
}

/* Utilitaires géométriques 2D ─────────────────────────── */

export function polygonArea(pts) {          // pts: [{x,y}] — aire absolue
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

export function polygonCentroid(pts) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    a += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {                 // dégénéré : moyenne simple
    for (const p of pts) { cx += p.x; cy += p.y; }
    return { x: cx / pts.length, y: cy / pts.length };
  }
  a *= 3;
  return { x: cx / a, y: cy / a };
}

export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
export const dist  = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const rand  = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const pick  = arr => arr[(Math.random() * arr.length) | 0];

/** Angle normalisé dans ]-π, π] */
export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
