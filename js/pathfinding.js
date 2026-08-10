/* ═══════════════════════════════════════════════════════
   pathfinding.js
   • A* 8-directions avec tas binaire et tampons réutilisés
   • lissage de chemin (string-pulling par ligne de vue)
   • flow-fields (Dijkstra) pour les destinations partagées
     (hélico, largages) : un seul calcul sert à N agents
   ═══════════════════════════════════════════════════════ */

import { CFG, T, BLOCK_MOVE, BLOCK_DRIVE, BLOCKADE, GROUND } from './config.js';

const SQ2 = Math.SQRT2;
/* Coût minimal d'une cellule (une route). */
const MIN_COST = 0.85;
/**
 * Échelle de l'heuristique (A* pondéré).
 *
 * Une heuristique calée sur le coût minimal absolu — celui d'une route — est
 * très mal informée dès que le terrain courant coûte deux fois plus : l'A*
 * dégénère en Dijkstra, explore un disque énorme et épuise son budget avant
 * d'arriver. On la cale donc sur le terrain *typique* de la carte : proche de
 * 1 en ville, vers 2 en forêt. Les trajets deviennent légèrement sous-optimaux
 * là où le sol est meilleur que la moyenne, contre un effondrement du nombre
 * d'expansions — le compromis habituel en jeu.
 */
const hScale = g => Math.max(MIN_COST, g.meanDiff || 1);
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DC = [1, 1, 1, 1, SQ2, SQ2, SQ2, SQ2];

/* ── Tas binaire min (index + priorité) ────────────────── */
class Heap {
  constructor(cap = 1024) {
    this.id = new Int32Array(cap);
    this.pr = new Float32Array(cap);
    this.size = 0;
  }
  clear() { this.size = 0; }
  grow() {
    const id = new Int32Array(this.id.length * 2);
    const pr = new Float32Array(this.pr.length * 2);
    id.set(this.id); pr.set(this.pr);
    this.id = id; this.pr = pr;
  }
  push(v, p) {
    if (this.size === this.id.length) this.grow();
    let i = this.size++;
    this.id[i] = v; this.pr[i] = p;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.pr[par] <= this.pr[i]) break;
      this.swap(par, i); i = par;
    }
  }
  pop() {
    const top = this.id[0];
    if (--this.size > 0) {
      this.id[0] = this.id[this.size]; this.pr[0] = this.pr[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.pr[l] < this.pr[m]) m = l;
        if (r < this.size && this.pr[r] < this.pr[m]) m = r;
        if (m === i) break;
        this.swap(m, i); i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    const ti = this.id[a]; this.id[a] = this.id[b]; this.id[b] = ti;
    const tp = this.pr[a]; this.pr[a] = this.pr[b]; this.pr[b] = tp;
  }
}

/* ═══ A* ══════════════════════════════════════════════ */
export class PathFinder {
  /** @param {'foot'|'road'} mode — un véhicule ne quitte jamais la voirie. */
  constructor(grid, mode = 'foot') {
    this.g = grid;
    this.mode = mode;
    /* Profil de coût, réglé avant chaque recherche. Les tampons sont remis à
       zéro par estampille à chaque appel : basculer entre deux recherches est
       sans effet de bord, et évite de dupliquer 4 tableaux de la taille de la
       carte pour un second jeu de coûts. */
    this.profile = 'human';
    const n = grid.n;
    this.gScore = new Float32Array(n);
    this.came   = new Int32Array(n);
    this.stamp  = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.mark   = 0;
    this.heap   = new Heap(4096);
    this.stats  = { calls: 0, nodes: 0, fails: 0, unreachable: 0 };
  }

  /**
   * Coût de traversée d'une cellule (Infinity si bloquée).
   * À pied, il reprend exactement la pénibilité du sol utilisée pour la
   * vitesse et la fatigue : un survivant qui « trouve » une route la trouve
   * parce qu'elle lui coûtera vraiment moins cher. Le profil `zombie` n'en
   * retient qu'une fraction — ils foncent tout droit.
   */
  cost(i) {
    const g = this.g, f = g.flags[i];
    if (this.mode === 'road') {
      /* Hors voirie, ou barrage : impraticable pour un véhicule. */
      if ((f & T.ROAD) === 0 || (f & BLOCK_DRIVE)) return Infinity;
      return MIN_COST;
    }
    if (f & BLOCK_MOVE) return Infinity;
    g.ensureDifficulty();
    const c = g.diff[i] / 64;
    return this.profile === 'zombie' ? 1 + (c - 1) * GROUND.zombiePathShare : c;
  }

  /** Cellule praticable pour ce mode de déplacement. */
  ok(cx, cy) {
    const g = this.g;
    if (!g.inBounds(cx, cy)) return false;
    return isFinite(this.cost(cy * g.w + cx));
  }

  /** Composante connexe pertinente pour ce mode. */
  compOf(i) {
    const g = this.g;
    if (this.mode === 'road') { g.ensureRoadComponents(); return g.rComp[i]; }
    g.ensureComponents(); return g.comp[i];
  }

  /**
   * Cherche un chemin (coordonnées monde). Retourne un tableau de
   * waypoints {x,y} lissés, ou null.
   */
  find(sx, sy, tx, ty, maxNodes = CFG.PATH_MAX_NODES) {
    const g = this.g, c = g.cell, W = g.w;
    let s = clampCell(g, (sx / c) | 0, (sy / c) | 0);
    let t = clampCell(g, (tx / c) | 0, (ty / c) | 0);
    if (!s || !t) return null;

    // Départ impraticable (poussé dans un mur, véhicule hors voirie) → repli
    if (!this.ok(s.x, s.y)) { const f = this.nearestOk(s.x, s.y, 10); if (!f) return null; s = f; }
    // Arrivée impraticable → viser la cellule praticable la plus proche
    if (!this.ok(t.x, t.y)) { const f = this.nearestOk(t.x, t.y, 30); if (!f) return null; t = f; }

    const si = s.y * W + s.x, ti = t.y * W + t.x;
    if (si === ti) return [{ x: tx, y: ty }];

    /* Rejet immédiat si départ et arrivée sont dans deux zones non reliées :
       inutile de dérouler un A* complet pour découvrir qu'aucun chemin
       n'existe. */
    if (this.compOf(si) !== this.compOf(ti)) { this.stats.unreachable++; return null; }

    /* Raccourci : ligne droite dégagée.
       Attention — « dégagé » ne veut pas dire « praticable ». Prendre ce
       raccourci dès que rien ne bloque revenait à traverser 400 m de sous-bois
       en ligne droite alors qu'une route longeait le trajet : le terrain était
       calculé mais jamais consulté. On ne l'emprunte donc que si la ligne est
       elle-même peu coûteuse, ou trop courte pour qu'un détour rapporte. */
    const tgx = (t.x + .5) * c, tgy = (t.y + .5) * c;
    if (this.clearLine(sx, sy, tgx, tgy)) {
      const straight = Math.hypot(tgx - sx, tgy - sy);
      if (straight < 60 || this.profile === 'zombie' ||
          this.lineDifficulty(sx, sy, tgx, tgy) <= 1.15)
        return [{ x: tgx, y: tgy }];
    }

    const { gScore, came, stamp, closed, heap } = this;
    const mark = ++this.mark;
    heap.clear();
    gScore[si] = 0; came[si] = -1; stamp[si] = mark;
    heap.push(si, 0);
    this.stats.calls++;

    let nodes = 0, found = false;
    const tcx = t.x, tcy = t.y;
    const hs = hScale(g);

    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === mark) continue;    // doublon laissé par le tas
      closed[cur] = mark;
      if (cur === ti) { found = true; break; }
      if (++nodes > maxNodes) break;
      const cx = cur % W, cy = (cur / W) | 0;
      const gc = gScore[cur];

      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= g.h) continue;
        const ni = ny * W + nx;
        const cc = this.cost(ni);
        if (cc === Infinity) continue;
        if (d >= 4) {   // pas de passage en diagonale entre deux angles
          if (!isFinite(this.cost(cy * W + nx)) || !isFinite(this.cost(ny * W + cx))) continue;
        }
        if (closed[ni] === mark) continue;
        const ng = gc + cc * DC[d];
        if (stamp[ni] === mark && ng >= gScore[ni]) continue;
        stamp[ni] = mark; gScore[ni] = ng; came[ni] = cur;
        const dx = Math.abs(nx - tcx), dy = Math.abs(ny - tcy);
        const hh = (dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx) * hs;
        heap.push(ni, ng + hh);
      }
    }
    this.stats.nodes += nodes;
    if (!found) { this.stats.fails++; return null; }

    /* Reconstruction */
    const raw = [];
    for (let i = ti; i !== -1; i = came[i]) {
      raw.push({ x: ((i % W) + 0.5) * c, y: (((i / W) | 0) + 0.5) * c });
      if (raw.length > 6000) break;
    }
    raw.reverse();
    raw[raw.length - 1] = { x: tx, y: ty };
    return this.smooth(sx, sy, raw);
  }

  /** String-pulling : supprime les waypoints inutiles. */
  smooth(sx, sy, pts) {
    if (pts.length <= 2) return pts;
    const out = [];
    let anchorX = sx, anchorY = sy, i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1, adv = -1;
      // recherche gloutonne du plus lointain point visible
      for (; j > i; j--) {
        if (this.clearLine(anchorX, anchorY, pts[j].x, pts[j].y)) { adv = j; break; }
      }
      if (adv === -1) adv = i + 1;
      out.push(pts[adv]);
      anchorX = pts[adv].x; anchorY = pts[adv].y;
      i = adv;
    }
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  /** Ligne dégagée pour le déplacement (échantillonnage 1 cellule). */
  clearLine(x0, y0, x1, y1) {
    const g = this.g, c = g.cell;
    const road = this.mode === 'road';
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.ceil(len / (c * 0.7));
    if (steps === 0) return true;
    const ux = dx / steps, uy = dy / steps;
    let x = x0, y = y0;
    for (let i = 0; i <= steps; i++) {
      if (road ? !g.driveable(x, y) : !g.walkable(x, y)) return false;
      x += ux; y += uy;
    }
    return true;
  }

  /** Pénibilité moyenne du sol le long d'un segment (1 = terrain neutre). */
  lineDifficulty(x0, y0, x1, y1) {
    const g = this.g, c = g.cell;
    g.ensureDifficulty();
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / (c * 2)));
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
      const cx = (x / c) | 0, cy = (y / c) | 0;
      sum += g.inBounds(cx, cy) ? g.diff[cy * g.w + cx] / 64 : 1;
    }
    return sum / (steps + 1);
  }

  /** Cellule praticable la plus proche, selon le mode. */
  nearestOk(cx, cy, maxRing) {
    if (this.ok(cx, cy)) return { x: cx, y: cy };
    for (let r = 1; r <= maxRing; r++) {
      for (let i = -r; i <= r; i++) {
        const cand = [[cx + i, cy - r], [cx + i, cy + r], [cx - r, cy + i], [cx + r, cy + i]];
        for (const [ax, ay] of cand) if (this.ok(ax, ay)) return { x: ax, y: ay };
      }
    }
    return null;
  }
}

function clampCell(g, cx, cy) {
  if (cx < 0) cx = 0; if (cy < 0) cy = 0;
  if (cx >= g.w) cx = g.w - 1; if (cy >= g.h) cy = g.h - 1;
  return { x: cx, y: cy };
}

function nearestFreeCell(g, cx, cy, maxRing) {
  for (let r = 1; r <= maxRing; r++) {
    for (let i = -r; i <= r; i++) {
      const cand = [[cx + i, cy - r], [cx + i, cy + r], [cx - r, cy + i], [cx + r, cy + i]];
      for (const [ax, ay] of cand) if (g.cellWalkable(ax, ay)) return { x: ax, y: ay };
    }
  }
  return null;
}

/* ═══ Flow field (Dijkstra depuis un but) ═════════════ */
export class FlowField {
  constructor(grid, tx, ty) {
    this.g = grid;
    this.version = grid.version;
    this.dist = new Float32Array(grid.n).fill(Infinity);
    this.dirX = new Int8Array(grid.n);
    this.dirY = new Int8Array(grid.n);
    this.goal = { x: tx, y: ty };
    this.build(tx, ty);
  }

  build(tx, ty) {
    const g = this.g, W = g.w, c = g.cell;
    let cx = (tx / c) | 0, cy = (ty / c) | 0;
    if (!g.cellWalkable(cx, cy)) {
      const f = nearestFreeCell(g, Math.max(0, Math.min(W - 1, cx)), Math.max(0, Math.min(g.h - 1, cy)), 25);
      if (!f) { this.empty = true; return; }
      cx = f.x; cy = f.y;
    }
    g.ensureDifficulty();
    const heap = new Heap(8192);
    const done = new Uint8Array(g.n);
    const start = cy * W + cx;
    this.dist[start] = 0;
    heap.push(start, 0);
    const flags = g.flags;

    while (heap.size) {
      const cur = heap.pop();
      if (done[cur]) continue;              // entrée périmée dans le tas
      done[cur] = 1;
      const d0 = this.dist[cur];
      const ux = cur % W, uy = (cur / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = ux + DX[k], ny = uy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= g.h) continue;
        const ni = ny * W + nx;
        if (done[ni]) continue;
        const f = flags[ni];
        if (f & BLOCK_MOVE) continue;
        if (k >= 4 && ((flags[uy * W + nx] & BLOCK_MOVE) || (flags[ny * W + ux] & BLOCK_MOVE))) continue;
        /* Même pénibilité que l'A* à pied : les civils convergent vers
           l'hélicoptère par le chemin le moins épuisant, pas le plus court. */
        const step = (g.diff[ni] / 64) * DC[k];
        const nd = d0 + step;
        if (nd < this.dist[ni]) {
          this.dist[ni] = nd;
          this.dirX[ni] = -DX[k];   // direction vers le but = retour vers `cur`
          this.dirY[ni] = -DY[k];
          heap.push(ni, nd);
        }
      }
    }
  }

  /** Direction normalisée vers le but depuis (x,y), ou null si inaccessible. */
  dirAt(x, y) {
    const g = this.g, c = g.cell;
    const cx = (x / c) | 0, cy = (y / c) | 0;
    if (!g.inBounds(cx, cy)) return null;
    const i = cy * g.w + cx;
    if (!isFinite(this.dist[i])) return null;
    const dx = this.dirX[i], dy = this.dirY[i];
    if (!dx && !dy) return { x: 0, y: 0, arrived: true };
    const l = Math.hypot(dx, dy);
    return { x: dx / l, y: dy / l, arrived: false };
  }
  reachable(x, y) {
    const g = this.g, c = g.cell;
    const cx = (x / c) | 0, cy = (y / c) | 0;
    if (!g.inBounds(cx, cy)) return false;
    return isFinite(this.dist[cy * g.w + cx]);
  }
  distAt(x, y) {
    const g = this.g, c = g.cell;
    const cx = (x / c) | 0, cy = (y / c) | 0;
    if (!g.inBounds(cx, cy)) return Infinity;
    return this.dist[cy * g.w + cx] * c;
  }
}
