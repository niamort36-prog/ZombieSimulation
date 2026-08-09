/* ═══════════════════════════════════════════════════════
   sim.js — cœur de la simulation
   Pas fixe 20 Hz : perception, IA, déplacement, combat,
   infection, opérations (hélico / frappes / largages).
   ═══════════════════════════════════════════════════════ */

import { CFG, T, KIND, UNIT, WEAPON, ST, BLOCK_MOVE } from './config.js';
import { Grid } from './grid.js';
import { PathFinder, FlowField } from './pathfinding.js';
import { SpatialHash } from './spatial.js';
import { makeEntity, giveWeapon, addAmmo, isPrey, isThreat, isFighter } from './entities.js';
import { dist, dist2, clamp, rand, randInt, pick, wrapAngle } from './geo.js';

export class Sim {
  constructor() {
    this.ready = false;
    this.time = 0;
    this.running = false;
    this.speed = 1;

    this.entities = [];
    this.corpses = [];
    this.blood = [];
    this.effects = [];
    this.helis = [];
    this.strikes = [];
    this.crates = [];
    this.buildings = [];

    this.pathQueue = [];
    this.stats = { civ: 0, pol: 0, mil: 0, zom: 0, evac: 0, dead: 0, bitten: 0 };

    /* Paramètres pilotés par l'interface */
    this.params = {
      density: 1, outdoorPct: 25, police: 12, military: 24, armedCivPct: 3,
      zCount: 60, zFastPct: 20, zSlow: 0.8, zFast: 4, turnDelay: 12,
      zSight: 45, zHear: 90, azimuths: new Set(['N']),
      heliCap: 12, heliBoard: 3, heliWait: 45, strikeRadius: 40,
      autoWave: false, wavePeriod: 120,
    };
    this._waveT = 0;
  }

  /* ═══ Mise en place ═══════════════════════════════════ */
  setup(frame, grid, buildings) {
    this.frame = frame;
    this.grid = grid;
    this.buildings = buildings;
    this.pf = new PathFinder(grid);
    this.hash = new SpatialHash(frame.width, frame.height, 16);
    this.indexBuildings();
    this.reset();
    this.ready = true;
  }

  /** Index statique des bâtiments (par centroïde) : évite les boucles
      O(entités × bâtiments) dans la perception et la propagation du bruit. */
  indexBuildings() {
    const C = 40;
    this.bCell = C;
    this.bw = Math.max(1, Math.ceil(this.frame.width / C));
    this.bh = Math.max(1, Math.ceil(this.frame.height / C));
    this.bBuckets = new Array(this.bw * this.bh);
    for (let i = 0; i < this.bBuckets.length; i++) this.bBuckets[i] = [];
    for (const b of this.buildings) {
      const cx = clamp((b.c.x / C) | 0, 0, this.bw - 1);
      const cy = clamp((b.c.y / C) | 0, 0, this.bh - 1);
      this.bBuckets[cy * this.bw + cx].push(b);
    }
  }

  queryBuildings(x, y, r, fn) {
    if (!this.bBuckets) return;
    const C = this.bCell;
    const x0 = Math.max(0, ((x - r) / C) | 0), x1 = Math.min(this.bw - 1, ((x + r) / C) | 0);
    const y0 = Math.max(0, ((y - r) / C) | 0), y1 = Math.min(this.bh - 1, ((y + r) / C) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.bw;
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.bBuckets[row + cx];
        for (let i = 0; i < bucket.length; i++) {
          const b = bucket[i];
          const d = dist(b.c.x, b.c.y, x, y);
          if (d <= r) fn(b, d);
        }
      }
    }
  }

  reset() {
    this.entities.length = 0;
    this.corpses.length = 0;
    this.blood.length = 0;
    this.effects.length = 0;
    this.helis.length = 0;
    this.strikes.length = 0;
    this.crates.length = 0;
    this.pathQueue.length = 0;
    this.time = 0;
    this._waveT = 0;
    this.stats = { civ: 0, pol: 0, mil: 0, zom: 0, evac: 0, dead: 0, bitten: 0 };
    for (const b of this.buildings) b.occupants = [];
    this._fields = new Map();
  }

  /* ═══ Peuplement ══════════════════════════════════════ */
  populate() {
    const p = this.params, g = this.grid, f = this.frame;
    const outdoorRatio = p.outdoorPct / 100;

    /* — Civils logés dans les bâtiments — */
    for (const b of this.buildings) {
      for (let i = 0; i < b.capacity; i++) {
        const outside = Math.random() < outdoorRatio;
        let pos = outside ? this.spawnAtDoor(b) : { x: b.c.x, y: b.c.y };
        if (!pos) pos = { x: b.c.x, y: b.c.y };
        const e = makeEntity(KIND.CIV, pos.x, pos.y, { home: b });
        e.indoor = !outside;
        e.state = e.indoor ? ST.INDOOR : ST.WANDER;
        if (Math.random() < p.armedCivPct / 100)
          giveWeapon(e, Math.random() < 0.7 ? 'pistol' : 'shotgun');
        b.occupants.push(e);
        this.add(e);
      }
    }

    /* — Population diffuse si la zone est vide de bâtiments — */
    if (this.entities.length < 5) {
      const n = Math.round(f.areaKm2 * CFG.POP.EMPTY_ZONE_DENSITY * p.density);
      for (let i = 0; i < n; i++) {
        const pos = this.randomFreePoint();
        if (!pos) break;
        const e = makeEntity(KIND.CIV, pos.x, pos.y);
        e.state = ST.WANDER;
        this.add(e);
      }
    }

    /* — Forces de l'ordre : elles apparaissent sur la voirie — */
    for (let i = 0; i < p.police; i++) {
      const pos = this.randomFreePoint(true);
      if (!pos) break;
      const e = makeEntity(KIND.POL, pos.x, pos.y, { weapon: 'pistol' });
      e.state = ST.PATROL;
      this.add(e);
    }
    for (let i = 0; i < p.military; i++) {
      const pos = this.randomFreePoint(true);
      if (!pos) break;
      const w = Math.random() < 0.12 ? 'lmg' : Math.random() < 0.25 ? 'smg' : 'rifle';
      const e = makeEntity(KIND.MIL, pos.x, pos.y, { weapon: w });
      e.state = ST.PATROL;
      this.add(e);
    }
    this.countStats();
  }

  add(e) { this.entities.push(e); return e; }

  /** Porte du bâtiment : point libre en bordure, calculé une fois puis mis en
      cache. Indispensable — le centroïde est une cellule bloquée, viser
      celui-ci fait échouer systématiquement le pathfinding. */
  doorOf(b) {
    if (b.door === undefined) b.door = this.exitPoint(b);
    return b.door;
  }

  /** Position de sortie : autour de la porte, avec un peu de dispersion. */
  spawnAtDoor(b) {
    const d = this.doorOf(b);
    if (!d) return null;
    for (let i = 0; i < 6; i++) {
      const x = d.x + rand(-4, 4), y = d.y + rand(-4, 4);
      if (this.canStand(x, y, 0.5)) return { x, y };
    }
    return { x: d.x, y: d.y };
  }

  /**
   * Porte du bâtiment : on longe le contour réel et on cherche une cellule
   * libre juste à l'extérieur, en privilégiant celles marquées « voirie ».
   * Tirer un point au hasard autour du centroïde donnait des portes situées
   * dans une cour intérieure fermée — donc inatteignables, et le pathfinding
   * échouait en boucle.
   */
  exitPoint(b) {
    const g = this.grid;
    if (!b.pts || b.pts.length < 3) return g.nearestFree(b.c.x, b.c.y, 30);

    g.ensureComponents();
    const onRoad = [], free = [];
    const N = b.pts.length;
    for (let i = 0; i < N; i++) {
      const a = b.pts[i], c = b.pts[(i + 1) % N];
      const ex = c.x - a.x, ey = c.y - a.y;
      const len = Math.hypot(ex, ey);
      if (len < 0.5) continue;
      const nx = -ey / len, ny = ex / len;          // normale à l'arête
      const steps = Math.min(12, Math.max(1, Math.floor(len / 3)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, px = a.x + ex * t, py = a.y + ey * t;
        for (let sign = -1; sign <= 1; sign += 2) {
          for (const off of [1.8, 3.2, 5]) {
            const qx = px + nx * sign * off, qy = py + ny * sign * off;
            if (!this.canStand(qx, qy, 0.5)) continue;
            /* Une porte qui donne sur une cour fermée piège l'occupant : on
               n'en veut pas tant qu'une sortie sur la zone principale existe. */
            if (!g.inMainComponent(qx, qy)) continue;
            ((g.flagAt(qx, qy) & T.ROAD) ? onRoad : free).push({ x: qx, y: qy });
            break;                                   // 1 candidat par direction
          }
        }
      }
    }
    if (onRoad.length) return pick(onRoad);
    if (free.length) return pick(free);
    return g.nearestFreeMain(b.c.x, b.c.y, 60) || g.nearestFree(b.c.x, b.c.y, 30);
  }

  randomFreePoint(preferRoad = false) {
    const g = this.grid, f = this.frame;
    for (let i = 0; i < 400; i++) {
      const x = rand(0, f.width), y = rand(0, f.height);
      const fl = g.flagAt(x, y);
      if (fl & BLOCK_MOVE) continue;
      if (preferRoad && !(fl & T.ROAD) && i < 250) continue;
      if (!g.inMainComponent(x, y)) continue;   // jamais dans une cour fermée
      return { x, y };
    }
    return g.nearestFreeMain(f.width / 2, f.height / 2, 200);
  }

  /* ═══ Vagues de zombies ═══════════════════════════════ */
  spawnWave(count = null, azimuths = null) {
    const p = this.params, f = this.frame, g = this.grid;
    const n = count ?? p.zCount;
    const az = [...(azimuths ?? p.azimuths)];
    if (!az.length) az.push('N');
    let spawned = 0;

    for (let i = 0; i < n; i++) {
      const a = pick(az);
      let x, y, hx = 0, hy = 0;
      const m = 4;
      switch (a) {
        case 'N': x = rand(0, f.width);  y = rand(m, m + 18); hy = 1;  break;
        case 'S': x = rand(0, f.width);  y = f.height - rand(m, m + 18); hy = -1; break;
        case 'O': x = rand(m, m + 18);   y = rand(0, f.height); hx = 1; break;
        default:  x = f.width - rand(m, m + 18); y = rand(0, f.height); hx = -1; break;
      }
      const spot = g.nearestFreeMain(x, y, 60);
      if (!spot) continue;
      const fast = Math.random() < p.zFastPct / 100;
      const e = makeEntity(KIND.ZOM, spot.x, spot.y, { zType: fast ? 'fast' : 'slow' });
      e.baseSpeed = e.runSpeed = fast ? p.zFast : p.zSlow;
      e.hp = e.maxHp = fast ? 55 : 75;
      e.sight = p.zSight;
      e.dir = Math.atan2(hy, hx);
      e.wx = hx; e.wy = hy;
      e.state = ST.WANDER;
      this.add(e);
      spawned++;
    }
    this.countStats();
    return spawned;
  }

  spawnZombiesAt(x, y, count = 10, radius = 25) {
    const p = this.params, g = this.grid;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * radius;
      const spot = g.nearestFreeMain(x + Math.cos(a) * r, y + Math.sin(a) * r, 20);
      if (!spot) continue;
      const fast = Math.random() < p.zFastPct / 100;
      const e = makeEntity(KIND.ZOM, spot.x, spot.y, { zType: fast ? 'fast' : 'slow' });
      e.baseSpeed = e.runSpeed = fast ? p.zFast : p.zSlow;
      e.hp = e.maxHp = fast ? 55 : 75;
      e.sight = p.zSight;
      e.state = ST.WANDER;
      this.add(e); n++;
    }
    this.countStats();
    return n;
  }

  /* ═══ Boucle ══════════════════════════════════════════ */
  step(dt) {
    if (!this.ready) return;
    this.time += dt;

    /* Vagues automatiques */
    if (this.params.autoWave) {
      this._waveT += dt;
      if (this._waveT >= this.params.wavePeriod) { this._waveT = 0; this.spawnWave(); }
    }

    /* 1 — index spatial */
    this.hash.clear();
    const ents = this.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.alive && !e.indoor && e.state !== ST.EVACUATED) this.hash.insert(e);
    }

    /* 2 — opérations */
    this.updateStrikes(dt);
    this.updateHelis(dt);
    this.updateCrates(dt);

    /* 3 — entités */
    for (let i = 0; i < ents.length; i++) this.updateEntity(ents[i], dt);

    /* 4 — file de pathfinding */
    this.flushPaths();

    /* 5 — effets & nettoyage */
    this.updateEffects(dt);
    this.cull();
  }

  /* ── Nettoyage / statistiques ── */
  cull() {
    const ents = this.entities;
    let w = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.state === ST.DEAD) {
        this.corpses.push({ x: e.x, y: e.y, dir: e.dir, kind: e.kind, t: this.time });
        if (this.corpses.length > 900) this.corpses.shift();
        continue;
      }
      if (e.state === ST.EVACUATED) continue;
      ents[w++] = e;
    }
    ents.length = w;
    this.countStats();
  }

  countStats() {
    let civ = 0, pol = 0, mil = 0, zom = 0;
    for (const e of this.entities) {
      if (!e.alive) continue;
      switch (e.kind) {
        case KIND.CIV: civ++; break;
        case KIND.POL: pol++; break;
        case KIND.MIL: mil++; break;
        case KIND.ZOM: zom++; break;
      }
    }
    this.stats.civ = civ; this.stats.pol = pol; this.stats.mil = mil; this.stats.zom = zom;
  }

  /* ═══ Pathfinding en file ═════════════════════════════ */
  requestPath(e, tx, ty, priority = 0) {
    if (e._queued) return;
    e._queued = true;
    e.pathGoal = { x: tx, y: ty };
    this.pathQueue.push({ e, tx, ty, priority });
  }

  flushPaths() {
    if (!this.pathQueue.length) return;
    if (this.pathQueue.length > 8) this.pathQueue.sort((a, b) => b.priority - a.priority);
    const n = Math.min(CFG.PATH_BUDGET, this.pathQueue.length);
    for (let i = 0; i < n; i++) {
      const r = this.pathQueue[i];
      const e = r.e;
      e._queued = false;
      if (!e.alive || e.indoor) continue;
      /* Les requêtes peu prioritaires reçoivent un budget d'exploration réduit :
         une trajectoire approximative suffit pour de l'errance ou de la traque
         lointaine, et cela évite qu'un objectif inatteignable ne coûte 14 000
         expansions à chaque tentative. */
      const budget = r.priority >= 0.7 ? CFG.PATH_MAX_NODES
                   : r.priority >= 0.4 ? CFG.PATH_MAX_NODES * 0.5
                   : CFG.PATH_MAX_NODES * 0.25;
      const path = this.pf.find(e.x, e.y, r.tx, r.ty, budget | 0);
      if (path) {
        e.path = path; e.pathI = 0; e.pathFails = 0;
        e.pathT = CFG.PATH_REFRESH * rand(0.85, 1.3);
      } else {
        /* Échec (objectif inatteignable ou budget épuisé) : on espace les
           tentatives suivantes au lieu de rejouer le même calcul en boucle. */
        e.path = null; e.pathFails++;
        e.pathT = CFG.PATH_REFRESH * rand(0.85, 1.3) * Math.min(6, 1 + e.pathFails);
      }
    }
    for (let i = n; i < this.pathQueue.length; i++) this.pathQueue[i].e._queued = false;
    this.pathQueue.length = 0;
  }

  /** Flow-field mis en cache pour une destination partagée. */
  getField(key, tx, ty) {
    let f = this._fields.get(key);
    if (f && f.version === this.grid.version) return f;
    f = new FlowField(this.grid, tx, ty);
    this._fields.set(key, f);
    return f;
  }
  dropField(key) { this._fields.delete(key); }

  /* ═══ Bruit ═══════════════════════════════════════════ */
  emitNoise(x, y, radius, intensity = 1) {
    /* L'ouïe des zombies est réglable : 90 m est la valeur de référence. */
    const zScale = this.params.zHear / 90;
    const zRadius = radius * zScale;
    const outer = Math.max(radius, zRadius);

    this.hash.query(x, y, outer, (e, d2) => {
      if (!e.alive) return;
      const d = Math.sqrt(d2);
      if (e.kind === KIND.ZOM) {
        if (e.target || d > zRadius) return;        // déjà occupé, ou hors de portée
        const falloff = 1 - d / zRadius;
        if (Math.random() < 0.35 + falloff * 0.6) {
          e.heardX = x + rand(-8, 8);
          e.heardY = y + rand(-8, 8);
          e.heardT = this.time + 20 + falloff * 25;
          e.path = null;
        }
      } else if (d <= radius) {
        e.alert = clamp(e.alert + intensity * (1 - d / radius) * 0.55, 0, 2);
      }
    });

    /* Les civils à l'abri paniquent aussi */
    this.queryBuildings(x, y, radius, (b, d) => {
      if (!b.occupants.length) return;
      const falloff = 1 - d / radius;
      for (const o of b.occupants) if (o.alive && o.indoor)
        o.alert = clamp(o.alert + intensity * falloff * 0.5, 0, 2);
    });
  }

  /* ═══ Entité : mise à jour ════════════════════════════ */
  updateEntity(e, dt) {
    if (!e.alive) {
      if (e.state === ST.TURNING) {
        e.turnT -= dt;
        if (e.turnT <= 0) this.turnIntoZombie(e);
      }
      return;
    }

    /* Les civils à l'abri représentent l'essentiel de la population : on les
       met à jour deux fois par seconde avec un dt agrégé, et de façon
       échelonnée pour lisser la charge. */
    if (e.indoor) {
      e.indoorT = (e.indoorT ?? rand(0, 0.5)) - dt;
      if (e.indoorT > 0) return;
      const agg = 0.5 - e.indoorT;
      e.indoorT = 0.5;
      e.alert = Math.max(0, e.alert - agg * 0.05);
      this.aiIndoor(e, agg);
      return;
    }

    e.fireT -= dt; e.biteT -= dt; e.senseT -= dt; e.losT -= dt; e.pathT -= dt;
    if (e.reloadT > 0) {
      e.reloadT -= dt;
      if (e.reloadT <= 0) this.finishReload(e);
    }
    e.alert = Math.max(0, e.alert - dt * 0.05);

    /* Blessé mortellement, en train de se transformer */
    if (e.state === ST.DOWNED) {
      e.turnT -= dt;
      if (e.turnT <= 0) this.turnIntoZombie(e);
      return;
    }

    if (e.kind === KIND.ZOM) this.aiZombie(e, dt);
    else if (e.kind === KIND.CIV) this.aiCivilian(e, dt);
    else this.aiFighter(e, dt);
  }

  /* ═══ IA — Zombie ═════════════════════════════════════ */
  aiZombie(e, dt) {
    /* 1. Acquisition de cible */
    if (e.senseT <= 0) {
      e.senseT = CFG.SENSE_REFRESH * rand(0.8, 1.4);
      if (!e.target || !isPrey(e.target) || dist(e.x, e.y, e.target.x, e.target.y) > e.sight * 1.6)
        e.target = this.findPrey(e);
      /* Sans proie visible : repérage d'un bâtiment habité (odeur / bruit) */
      e.zBuilding = e.target ? null : this.nearbyOccupiedBuilding(e);
    }

    /* 2. Cible visible → poursuite */
    if (e.target && isPrey(e.target)) {
      const d = dist(e.x, e.y, e.target.x, e.target.y);
      if (d < UNIT[KIND.ZOM].bite.reach + e.radius + e.target.radius) {
        this.bite(e, e.target);
        e.state = ST.ATTACK;
        this.face(e, e.target.x, e.target.y);
        return;
      }
      e.state = ST.SEEK;
      this.moveToward(e, e.target.x, e.target.y, dt, e.baseSpeed, 1);
      return;
    }
    e.target = null;

    /* 3. Bâtiment habité tout proche → tentative d'effraction */
    const b = (e.zBuilding && e.zBuilding.occupants.length && !e.zBuilding.destroyed)
      ? e.zBuilding : (e.zBuilding = null);
    if (b) {
      const door = this.doorOf(b) || b.c;
      const d = dist(e.x, e.y, door.x, door.y);
      if (d < 10) {
        b.breach = (b.breach || 0) + dt;
        this.face(e, b.c.x, b.c.y);
        if (b.breach > 6) { this.breachBuilding(b); b.breach = 0; }
        e.state = ST.ATTACK;
        return;
      }
      e.state = ST.SEEK;
      this.moveToward(e, door.x, door.y, dt, e.baseSpeed, 0.6);
      return;
    }

    /* 4. Bruit entendu */
    if (this.time < e.heardT) {
      e.state = ST.SEEK;
      const d = dist(e.x, e.y, e.heardX, e.heardY);
      if (d < 4) { e.heardT = 0; }
      else { this.moveToward(e, e.heardX, e.heardY, dt, e.baseSpeed * 0.9, 0.4); return; }
    }

    /* 5. Errance dans la direction d'arrivée */
    e.state = ST.WANDER;
    this.wander(e, dt, e.baseSpeed * 0.55);
  }

  findPrey(e) {
    let best = null, bestScore = Infinity;
    this.hash.query(e.x, e.y, e.sight, (o, d2) => {
      if (!isPrey(o)) return;
      const d = Math.sqrt(d2);
      // cône de vision large + repérage rapproché à 360°
      if (d > 6) {
        const a = Math.abs(wrapAngle(Math.atan2(o.y - e.y, o.x - e.x) - e.dir));
        if (a > e.fov / 2) return;
      }
      if (d > 3 && !this.grid.hasLOS(e.x, e.y, o.x, o.y)) return;
      const score = d - (o.state === ST.FLEE ? 8 : 0);   // les fuyards attirent
      if (score < bestScore) { bestScore = score; best = o; }
    });
    return best;
  }

  nearbyOccupiedBuilding(e) {
    let best = null, bd = 30;
    this.queryBuildings(e.x, e.y, 30, (b, d) => {
      if (!b.occupants.length || b.destroyed) return;
      if (d < bd) { bd = d; best = b; }
    });
    return best;
  }

  breachBuilding(b) {
    const occ = b.occupants.slice();
    for (const o of occ) {
      if (!o.alive || !o.indoor) continue;
      this.exitBuilding(o);
    }
    this.emitNoise(b.c.x, b.c.y, CFG.NOISE.scream, 0.8);
  }

  exitBuilding(e) {
    const b = e.home;
    const p = b ? this.spawnAtDoor(b) : this.grid.nearestFree(e.x, e.y, 20);
    if (!p) return;
    e.x = p.x; e.y = p.y;
    e.indoor = false;
    e.state = ST.FLEE;
    e.alert = 1.4;
    if (b) { const i = b.occupants.indexOf(e); if (i >= 0) b.occupants.splice(i, 1); }
  }

  bite(z, victim) {
    if (z.biteT > 0) return;
    z.biteT = UNIT[KIND.ZOM].bite.cooldown;
    const dmg = UNIT[KIND.ZOM].bite.dps * UNIT[KIND.ZOM].bite.cooldown;
    victim.hp -= dmg;
    victim.infected = true;
    victim.alert = 2;
    this.addBlood(victim.x, victim.y);
    if (Math.random() < 0.5) this.emitNoise(victim.x, victim.y, CFG.NOISE.scream, 0.7);
    if (victim.hp <= 0) this.downHuman(victim);
  }

  downHuman(e) {
    e.alive = false;
    e.state = ST.DOWNED;
    e.turnT = Math.max(0.2, this.params.turnDelay * rand(0.6, 1.5));
    e.path = null;
    e.target = null;
    this.stats.bitten++;
    this.addBlood(e.x, e.y, 2.2);
    if (e.home) { const i = e.home.occupants.indexOf(e); if (i >= 0) e.home.occupants.splice(i, 1); }
  }

  killOutright(e, gore = 1) {
    if (e.state === ST.DEAD) return;
    e.alive = false;
    e.state = ST.DEAD;
    this.stats.dead++;
    this.addBlood(e.x, e.y, gore);
    if (e.home) { const i = e.home.occupants.indexOf(e); if (i >= 0) e.home.occupants.splice(i, 1); }
  }

  turnIntoZombie(src) {
    const p = this.params;
    const fast = Math.random() < p.zFastPct / 100;
    const z = makeEntity(KIND.ZOM, src.x, src.y, { zType: fast ? 'fast' : 'slow' });
    z.baseSpeed = z.runSpeed = fast ? p.zFast : p.zSlow;
    z.hp = z.maxHp = fast ? 55 : 75;
    z.sight = p.zSight;
    z.dir = src.dir;
    z.state = ST.WANDER;
    this.add(z);
    src.state = ST.DEAD;           // la dépouille disparaît, le zombie la remplace
    src.alive = false;
    this.stats.dead++;
    this.emitNoise(src.x, src.y, CFG.NOISE.scream * 0.6, 0.4);
  }

  /* ═══ IA — civil à l'intérieur ════════════════════════ */
  aiIndoor(e, dt) {
    e.state = ST.INDOOR;

    /* Un hélicoptère posé à portée fait sortir les habitants : c'est le
       principal moyen de vider un quartier. */
    const heli = this.activeHeli();
    if (heli && heli.state === 'landed' && dist(e.x, e.y, heli.x, heli.y) < 320) {
      const door = (e.home && this.doorOf(e.home)) || { x: e.x, y: e.y };
      const field = this.getField('heli' + heli.id, heli.x, heli.y);
      if (field.reachable(door.x, door.y)) { this.exitBuilding(e); return; }
    }

    /* Sinon on reste barricadé : c'est la meilleure stratégie tant que la
       porte n'est pas enfoncée. Seule une minorité craque et tente sa chance
       dehors — sinon toute la ville se retrouve dans la rue dès la première
       rafale, et la mécanique d'abri ne sert plus à rien. */
    if (e.alert > 1.9 && Math.random() < 0.02) {
      const z = this.hash.nearest(e.x, e.y, 45, o => o.kind === KIND.ZOM && o.alive);
      if (!z) this.exitBuilding(e);
    }
  }

  /* ═══ IA — civil ══════════════════════════════════════ */
  aiCivilian(e, dt) {
    const p = this.params;

    /* Menace la plus proche */
    let threat = null, td = Infinity;
    if (e.senseT <= 0) {
      e.senseT = CFG.SENSE_REFRESH * rand(0.8, 1.3);
      const r = this.hash.nearest(e.x, e.y, e.sight, o =>
        o.kind === KIND.ZOM && o.alive && this.grid.hasLOS(e.x, e.y, o.x, o.y));
      e.target = r ? r.e : null;
    }
    if (e.target && e.target.alive) { threat = e.target; td = dist(e.x, e.y, threat.x, threat.y); }

    /* Civil armé, courageux et menace à bonne distance → il tire */
    if (threat && e.weapon && (e.mag > 0 || e.reserve > 0)) {
      const w = WEAPON[e.weapon];
      if (td < w.range * 0.7 && td > 3 && (e.alert > 0.6 || td < 25)) {
        this.face(e, threat.x, threat.y);
        this.tryFire(e, threat, td);
        if (td > 12) return;        // reste en place tant que la cible est loin
      }
    }

    /* Évacuation prioritaire */
    const heli = this.activeHeli();
    if (heli && heli.state === 'landed') {
      const d = dist(e.x, e.y, heli.x, heli.y);
      if (d < 6) { this.boardQueue(e, heli, dt); return; }
      if (d < 600) {
        const f = this.getField('heli' + heli.id, heli.x, heli.y);
        if (f.reachable(e.x, e.y)) {
          e.state = ST.GOTO;
          const dir = f.dirAt(e.x, e.y);
          if (dir) {
            const spd = (threat && td < 45 ? e.runSpeed : e.baseSpeed * 1.25);
            this.steer(e, dir.x, dir.y, dt, spd);
            return;
          }
        }
      }
    }

    /* Fuite */
    if (threat && td < 55) {
      e.state = ST.FLEE;
      e.alert = Math.max(e.alert, 1.2);
      if (this.time - (e._screamT || 0) > 6) {
        e._screamT = this.time;
        this.emitNoise(e.x, e.y, CFG.NOISE.scream * 0.7, 0.5);
      }
      /* direction opposée, corrigée par les obstacles */
      let ax = e.x - threat.x, ay = e.y - threat.y;
      const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
      const goal = this.freeDirection(e, ax, ay, 26);
      this.steer(e, goal.x, goal.y, dt, e.runSpeed);
      return;
    }

    /* Retour au calme : rentrer chez soi si possible */
    if (e.alert < 0.25 && e.home && !e.home.destroyed) {
      const door = this.doorOf(e.home);
      if (door) {
        const d = dist(e.x, e.y, door.x, door.y);
        if (d < 3) {
          e.indoor = true; e.state = ST.INDOOR;
          e.x = e.home.c.x; e.y = e.home.c.y;
          if (!e.home.occupants.includes(e)) e.home.occupants.push(e);
          return;
        }
        if (d < 220 && e.pathFails < 3) {
          e.state = ST.GOTO;
          this.moveToward(e, door.x, door.y, dt, e.baseSpeed, 0.3);
          return;
        }
      }
    }

    e.state = ST.WANDER;
    this.wander(e, dt, e.baseSpeed * (0.6 + e.alert * 0.5));
  }

  /* ═══ IA — gendarme / militaire ═══════════════════════ */
  aiFighter(e, dt) {
    const w = WEAPON[e.weapon];

    /* Acquisition */
    if (e.senseT <= 0) {
      e.senseT = CFG.SENSE_REFRESH * rand(0.7, 1.2);
      if (!e.target || !e.target.alive ||
          dist(e.x, e.y, e.target.x, e.target.y) > (w ? w.range : 40) * 1.15) {
        const r = this.hash.nearest(e.x, e.y, Math.min(e.sight, w ? w.range : 40), o =>
          isThreat(o) && this.grid.hasLOS(e.x, e.y, o.x, o.y));
        e.target = r ? r.e : null;
      }
    }

    /* Plus de munitions → ravitaillement ou repli */
    if (w && e.mag <= 0 && e.reserve <= 0) {
      const crate = this.nearestCrate(e);
      if (crate) {
        e.state = ST.RESUPPLY;
        if (dist(e.x, e.y, crate.x, crate.y) < 2.5) this.useCrate(e, crate);
        else this.moveToward(e, crate.x, crate.y, dt, e.runSpeed, 0.8);
        return;
      }
      if (e.target && dist(e.x, e.y, e.target.x, e.target.y) < 30) {
        e.state = ST.FLEE;
        let ax = e.x - e.target.x, ay = e.y - e.target.y;
        const l = Math.hypot(ax, ay) || 1;
        const g = this.freeDirection(e, ax / l, ay / l, 22);
        this.steer(e, g.x, g.y, dt, e.runSpeed);
        return;
      }
    }

    /* Engagement */
    if (e.target && e.target.alive && w) {
      const d = dist(e.x, e.y, e.target.x, e.target.y);
      this.face(e, e.target.x, e.target.y);
      if (d < w.range && this.grid.hasLOS(e.x, e.y, e.target.x, e.target.y)) {
        e.state = ST.ATTACK;
        this.tryFire(e, e.target, d);
        /* décrochage si le contact est trop proche */
        const keep = e.kind === KIND.MIL ? 14 : 11;
        if (d < keep) {
          let ax = e.x - e.target.x, ay = e.y - e.target.y;
          const l = Math.hypot(ax, ay) || 1;
          const g = this.freeDirection(e, ax / l, ay / l, 14);
          this.steer(e, g.x, g.y, dt, e.baseSpeed * 1.1);
        }
        return;
      }
      /* pas de vue : on se rapproche */
      e.state = ST.SEEK;
      this.moveToward(e, e.target.x, e.target.y, dt, e.baseSpeed * 1.15, 0.7);
      return;
    }

    /* Bruit récent */
    if (this.time < e.heardT) {
      e.state = ST.SEEK;
      if (dist(e.x, e.y, e.heardX, e.heardY) > 5) {
        this.moveToward(e, e.heardX, e.heardY, dt, e.baseSpeed * 1.1, 0.4);
        return;
      }
      e.heardT = 0;
    }

    /* Patrouille */
    if (e.patrol) {
      e.state = ST.PATROL;
      if (!e.patrolWP || dist(e.x, e.y, e.patrolWP.x, e.patrolWP.y) < 5 || e.pathFails > 2) {
        e.patrolWP = this.randomPointInRect(e.patrol);
        e.pathFails = 0; e.path = null;
      }
      if (e.patrolWP) this.moveToward(e, e.patrolWP.x, e.patrolWP.y, dt, e.baseSpeed, 0.3);
      return;
    }

    e.state = ST.PATROL;
    this.wander(e, dt, e.baseSpeed * 0.7);
  }

  randomPointInRect(r) {
    for (let i = 0; i < 30; i++) {
      const x = rand(r.x0, r.x1), y = rand(r.y0, r.y1);
      if (this.grid.walkable(x, y)) return { x, y };
    }
    return this.grid.nearestFree((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 40);
  }

  /* ═══ Tir ═════════════════════════════════════════════ */
  tryFire(e, target, d) {
    const w = WEAPON[e.weapon];
    if (!w || e.reloadT > 0) return;
    if (e.mag <= 0) { this.startReload(e); return; }
    if (e.fireT > 0) return;

    e.fireT = 60 / w.rpm;
    if (!w.auto) e.fireT *= rand(1, 1.5);
    e.mag--;

    /* Probabilité de toucher */
    const rangeFactor = clamp(1 - (d / w.range) * 0.85, 0.08, 1);
    const moveFactor = target.state === ST.SEEK || target.state === ST.FLEE ? 0.88 : 1;
    let hitP = clamp(e.skill * rangeFactor * moveFactor * (1 - w.spread * 3), 0.03, 0.97);
    if (e.alert > 1.3) hitP *= 0.85;                    // stress

    /* Un obstacle peut absorber la balle */
    if (!this.grid.hasLOS(e.x, e.y, target.x, target.y)) hitP = 0;

    const hit = Math.random() < hitP;
    this.effects.push({
      type: 'tracer', x0: e.x, y0: e.y,
      x1: hit ? target.x : target.x + rand(-4, 4), y1: hit ? target.y : target.y + rand(-4, 4),
      t: 0.09, kind: e.kind,
    });
    /* Le bruit interroge un large rayon : inutile de le faire à chaque balle,
       deux fois par seconde et par tireur suffit à alerter le voisinage. */
    if (this.time - (e.noiseT || -9) > 0.5) {
      e.noiseT = this.time;
      this.emitNoise(e.x, e.y, CFG.NOISE[w.noise], 1);
    }

    if (hit) {
      const head = Math.random() < w.hs;
      const dmg = head ? 9999 : w.dmg * rand(0.85, 1.15);
      this.damage(target, dmg, e);
      this.addBlood(target.x, target.y, head ? 1.6 : 0.7);
    }
    if (e.mag <= 0) this.startReload(e);
  }

  startReload(e) {
    const w = WEAPON[e.weapon];
    if (!w || e.reserve <= 0 || e.reloadT > 0) return;
    e.reloadT = w.reload * rand(0.9, 1.15);
  }
  finishReload(e) {
    const w = WEAPON[e.weapon];
    if (!w) return;
    const need = w.mag - e.mag;
    const take = Math.min(need, e.reserve);
    e.mag += take; e.reserve -= take;
  }

  damage(target, dmg, source) {
    if (!target.alive) return;
    target.hp -= dmg;
    target.alert = 2;
    if (target.kind !== KIND.ZOM && source && source.kind !== KIND.ZOM) {
      /* tir fratricide : on ne pénalise pas plus que les dégâts */
    }
    if (target.hp <= 0) {
      this.killOutright(target, 1);
      if (source) source.kills++;
    } else if (target.kind === KIND.ZOM && !target.target) {
      target.heardX = source ? source.x : target.x;
      target.heardY = source ? source.y : target.y;
      target.heardT = this.time + 25;
    }
  }

  /* ═══ Déplacement ═════════════════════════════════════ */

  /** Va vers (tx,ty) : ligne droite si dégagée, sinon A* mis en file. */
  moveToward(e, tx, ty, dt, speed, priority = 0) {
    const g = this.grid;
    const d = dist(e.x, e.y, tx, ty);

    /* Chemin direct */
    if (d < 28 && this.pf.clearLine(e.x, e.y, tx, ty)) {
      e.path = null;
      const dx = (tx - e.x) / (d || 1), dy = (ty - e.y) / (d || 1);
      this.steer(e, dx, dy, dt, speed);
      return;
    }

    /* Chemin existant : suivi des waypoints */
    if (e.path && e.pathI < e.path.length) {
      const goalMoved = e.pathGoal ? dist(e.pathGoal.x, e.pathGoal.y, tx, ty) > 12 : true;
      if (!goalMoved || e.pathT > 0) {
        /* On consomme d'un coup tous les waypoints déjà atteints, puis on
           avance : sinon l'entité perd un tick à chaque point de passage. */
        while (e.pathI < e.path.length &&
               dist(e.x, e.y, e.path[e.pathI].x, e.path[e.pathI].y) < 1.6) e.pathI++;

        if (e.pathI < e.path.length) {
          const wp = e.path[e.pathI];
          const wd = dist(e.x, e.y, wp.x, wp.y) || 1;
          this.steer(e, (wp.x - e.x) / wd, (wp.y - e.y) / wd, dt, speed);
          if (e.pathT <= 0 && goalMoved) this.requestPath(e, tx, ty, priority);
          return;
        }
        e.path = null;                       // arrivé au bout du chemin
      }
    }

    /* Objectif très lointain : on avance « au flair » vers lui sans payer un A*
       complet ; le vrai calcul se fera en approchant. */
    if (d > 260) {
      const free = this.freeDirection(e, (tx - e.x) / d, (ty - e.y) / d, 14);
      this.steer(e, free.x, free.y, dt, speed);
      return;
    }

    /* Demande de calcul + avance approximative en attendant */
    if (e.pathT <= 0) this.requestPath(e, tx, ty, priority);
    const dirx = (tx - e.x) / (d || 1), diry = (ty - e.y) / (d || 1);
    const free = this.freeDirection(e, dirx, diry, 10);
    this.steer(e, free.x, free.y, dt, speed * 0.85);
  }

  /** Cherche la direction la plus proche de (dx,dy) qui ne soit pas bloquée. */
  freeDirection(e, dx, dy, probe = 14) {
    const g = this.grid;
    const base = Math.atan2(dy, dx);
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
      const a = base + off;
      const cx = Math.cos(a), cy = Math.sin(a);
      if (this.pf.clearLine(e.x, e.y, e.x + cx * probe, e.y + cy * probe)) return { x: cx, y: cy };
    }
    return { x: dx, y: dy };
  }

  /** Applique la direction voulue + séparation + collision terrain. */
  steer(e, dx, dy, dt, speed) {
    /* Séparation locale */
    let sx = 0, sy = 0, cnt = 0;
    this.hash.query(e.x, e.y, 1.9, (o) => {
      if (o === e || !o.alive) return;
      const ox = e.x - o.x, oy = e.y - o.y;
      const d2 = ox * ox + oy * oy;
      if (d2 < 0.0004 || d2 > 3.6) return;
      const inv = 1 / Math.sqrt(d2);
      sx += ox * inv; sy += oy * inv; cnt++;
    });
    if (cnt) { dx += (sx / cnt) * 0.7; dy += (sy / cnt) * 0.7; }

    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;

    const mul = this.grid.speedMul(e.x, e.y);
    const step = speed * mul * dt;
    let nx = e.x + dx * step, ny = e.y + dy * step;

    /* Collision : glissement le long des murs */
    if (!this.canStand(nx, ny, e.radius)) {
      if (this.canStand(nx, e.y, e.radius)) ny = e.y;
      else if (this.canStand(e.x, ny, e.radius)) nx = e.x;
      else { nx = e.x; ny = e.y; e.stuckT += dt; }
    }
    if (nx !== e.x || ny !== e.y) {
      e.dir = Math.atan2(ny - e.y, nx - e.x);
      e.x = nx; e.y = ny;
      e.stuckT = Math.max(0, e.stuckT - dt);
    }

    /* Blocage prolongé → on jette le chemin et on tente autre chose */
    if (e.stuckT > 1.2) {
      e.stuckT = 0; e.path = null; e.pathT = 0;
      e.wx = Math.cos(e.dir + rand(2, 4)); e.wy = Math.sin(e.dir + rand(2, 4));
    }

    /* Filet de sécurité : rester dans la zone */
    const f = this.frame;
    e.x = clamp(e.x, 0.5, f.width - 0.5);
    e.y = clamp(e.y, 0.5, f.height - 0.5);
  }

  canStand(x, y, r) {
    const g = this.grid;
    if (x < 0 || y < 0 || x >= this.frame.width || y >= this.frame.height) return false;
    if (!g.walkable(x, y)) return false;
    /* on teste 4 points du corps pour éviter de traverser les coins */
    return g.walkable(x + r, y) && g.walkable(x - r, y) &&
           g.walkable(x, y + r) && g.walkable(x, y - r);
  }

  wander(e, dt, speed) {
    e.wanderT -= dt;
    if (e.wanderT <= 0 || (!e.wx && !e.wy)) {
      e.wanderT = rand(2.5, 7);
      const a = (e.wx || e.wy) ? Math.atan2(e.wy, e.wx) + rand(-0.9, 0.9) : rand(0, Math.PI * 2);
      e.wx = Math.cos(a); e.wy = Math.sin(a);
    }
    if (!this.pf.clearLine(e.x, e.y, e.x + e.wx * 8, e.y + e.wy * 8)) {
      const f = this.freeDirection(e, e.wx, e.wy, 10);
      e.wx = f.x; e.wy = f.y; e.wanderT = rand(1.5, 4);
    }
    this.steer(e, e.wx, e.wy, dt, speed);
  }

  face(e, x, y) { e.dir = Math.atan2(y - e.y, x - e.x); }

  /* ═══ Opérations : hélicoptères ═══════════════════════ */
  callHeli(x, y) {
    const spot = this.grid.nearestFreeMain(x, y, 60);
    if (!spot) return null;
    const f = this.frame;
    /* arrivée depuis le bord le plus proche */
    const edges = [
      { x: spot.x, y: -220 }, { x: spot.x, y: f.height + 220 },
      { x: -220, y: spot.y }, { x: f.width + 220, y: spot.y },
    ];
    edges.sort((a, b) => dist2(a.x, a.y, spot.x, spot.y) - dist2(b.x, b.y, spot.x, spot.y));
    const heli = {
      id: Date.now() % 100000 + Math.floor(Math.random() * 1000),
      x: edges[0].x, y: edges[0].y, lz: spot,
      state: 'inbound', t: 0, aboard: 0,
      capacity: this.params.heliCap,
      boardTimer: 0, waitT: this.params.heliWait,
      dir: 0,
    };
    this.helis.push(heli);
    return heli;
  }

  activeHeli() {
    for (const h of this.helis) if (h.state === 'landed' || h.state === 'inbound') return h;
    return null;
  }

  /** Le rotor s'entend en continu, mais on ne propage l'événement que 2×/s :
      la requête porte sur des centaines de mètres. */
  heliNoise(h, dt, radius, intensity) {
    h.noiseT = (h.noiseT || 0) - dt;
    if (h.noiseT > 0) return;
    h.noiseT = 0.5;
    this.emitNoise(h.x, h.y, radius, intensity);
  }

  updateHelis(dt) {
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      const spd = 55;                                  // m/s

      if (h.state === 'inbound' || h.state === 'leaving') {
        const tx = h.state === 'inbound' ? h.lz.x : h.exit.x;
        const ty = h.state === 'inbound' ? h.lz.y : h.exit.y;
        const d = dist(h.x, h.y, tx, ty);
        h.dir = Math.atan2(ty - h.y, tx - h.x);
        if (d < spd * dt) {
          h.x = tx; h.y = ty;
          if (h.state === 'inbound') {
            h.state = 'landed'; h.x = h.lz.x; h.y = h.lz.y;
            this.getField('heli' + h.id, h.x, h.y);
          } else {
            this.stats.evac += h.aboard;
            this.dropField('heli' + h.id);
            this.helis.splice(i, 1);
            continue;
          }
        } else {
          h.x += Math.cos(h.dir) * spd * dt;
          h.y += Math.sin(h.dir) * spd * dt;
        }
        this.heliNoise(h, dt, CFG.NOISE.heli * 0.6, 0.35);
        continue;
      }

      if (h.state === 'landed') {
        h.waitT -= dt;
        this.heliNoise(h, dt, CFG.NOISE.heli, 0.5);

        /* Embarquement : un civil à la fois */
        h.boardTimer -= dt;
        if (h.boardTimer <= 0) {
          const r = this.hash.nearest(h.x, h.y, 7, o =>
            o.alive && o.kind === KIND.CIV && o.state === ST.BOARD);
          if (r) {
            const c = r.e;
            c.state = ST.EVACUATED;
            c.alive = true;
            h.aboard++;
            h.boardTimer = this.params.heliBoard;
            if (c.home) { const k = c.home.occupants.indexOf(c); if (k >= 0) c.home.occupants.splice(k, 1); }
          } else h.boardTimer = 0.25;
        }

        if (h.aboard >= h.capacity || h.waitT <= 0) {
          const f = this.frame;
          const cands = [
            { x: h.x, y: -260 }, { x: h.x, y: f.height + 260 },
            { x: -260, y: h.y }, { x: f.width + 260, y: h.y },
          ];
          cands.sort((a, b) => dist2(a.x, a.y, h.x, h.y) - dist2(b.x, b.y, h.x, h.y));
          h.exit = cands[0];
          h.state = 'leaving';
        }
      }
    }
  }

  boardQueue(e, heli, dt) {
    e.state = ST.BOARD;
    e.path = null;
    /* petit ajustement pour se serrer contre l'appareil */
    const d = dist(e.x, e.y, heli.x, heli.y);
    if (d > 3) this.steer(e, (heli.x - e.x) / d, (heli.y - e.y) / d, dt, e.baseSpeed);
  }

  /* ═══ Opérations : frappes ════════════════════════════ */
  callStrike(x, y, radius = null, delay = 8) {
    const s = { x, y, r: radius ?? this.params.strikeRadius, t: delay, total: delay };
    this.strikes.push(s);
    return s;
  }

  updateStrikes(dt) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      if (s.t > 0) continue;
      this.explode(s.x, s.y, s.r);
      this.strikes.splice(i, 1);
    }
  }

  explode(x, y, r) {
    this.effects.push({ type: 'boom', x, y, r, t: 1.1, total: 1.1 });
    /* Dégâts avec atténuation */
    const victims = [];
    this.hash.query(x, y, r * 1.35, (e, d2) => victims.push([e, Math.sqrt(d2)]));
    for (const [e, d] of victims) {
      if (!e.alive && e.state !== ST.DOWNED) continue;
      const f = clamp(1 - d / (r * 1.2), 0, 1);
      if (f <= 0) continue;
      if (f > 0.45 || Math.random() < f) {
        if (e.state === ST.DOWNED) { e.state = ST.DEAD; this.stats.dead++; continue; }
        this.damage(e, 400 * f, null);
      }
    }
    /* Les occupants des bâtiments touchés meurent avec eux */
    for (const b of this.buildings) {
      if (dist(b.c.x, b.c.y, x, y) > r) continue;
      b.destroyed = true;
      for (const o of b.occupants.slice()) if (o.alive) this.killOutright(o, 1.5);
      b.occupants.length = 0;
    }
    this.grid.demolish(x, y, r * 0.85);
    this._fields.clear();
    this.emitNoise(x, y, CFG.NOISE.explosion, 1.5);
    for (let i = 0; i < 14; i++) {
      const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * r;
      this.addBlood(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.2, '#2a2320');
    }
  }

  /* ═══ Opérations : largages ═══════════════════════════ */
  callDrop(x, y, delay = 6) {
    const spot = this.grid.nearestFreeMain(x, y, 60) || { x, y };
    const c = { x: spot.x, y: spot.y, t: delay, landed: false, uses: 8 };
    this.crates.push(c);
    return c;
  }

  updateCrates(dt) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (!c.landed) {
        c.t -= dt;
        if (c.t <= 0) {
          c.landed = true;
          this.emitNoise(c.x, c.y, CFG.NOISE.crate, 0.4);
        }
        continue;
      }
      if (c.uses <= 0) { this.crates.splice(i, 1); continue; }
      /* Attire les unités à court de munitions */
      this.hash.query(c.x, c.y, 2.5, (e) => {
        if (!e.alive || e.kind === KIND.ZOM || c.uses <= 0) return;
        if (e.weapon && e.reserve > WEAPON[e.weapon].mag) return;
        this.useCrate(e, c);
      });
    }
  }

  nearestCrate(e) {
    let best = null, bd = 220;
    for (const c of this.crates) {
      if (!c.landed || c.uses <= 0) continue;
      const d = dist(e.x, e.y, c.x, c.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  useCrate(e, c) {
    if (c.uses <= 0) return;
    c.uses--;
    if (!e.weapon) giveWeapon(e, e.kind === KIND.CIV ? (Math.random() < .5 ? 'rifle' : 'shotgun') : 'rifle');
    else addAmmo(e, 4);
    e.alert = Math.max(e.alert, 0.6);
  }

  /* ═══ Ordres ══════════════════════════════════════════ */
  assignPatrol(rect, kinds = [KIND.MIL], maxUnits = 999) {
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
    const cands = this.entities
      .filter(e => e.alive && kinds.includes(e.kind))
      .sort((a, b) => dist2(a.x, a.y, cx, cy) - dist2(b.x, b.y, cx, cy))
      .slice(0, maxUnits);
    for (const e of cands) { e.patrol = rect; e.patrolWP = null; e.path = null; }
    return cands.length;
  }

  /* ═══ Effets ══════════════════════════════════════════ */
  addBlood(x, y, scale = 1, color = null) {
    this.blood.push({ x, y, r: rand(0.5, 1.1) * scale, c: color, t: this.time });
    if (this.blood.length > 1400) this.blood.shift();
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.t -= dt;
      if (fx.t <= 0) this.effects.splice(i, 1);
    }
  }
}
