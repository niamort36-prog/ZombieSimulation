/* ═══════════════════════════════════════════════════════
   vehicles.js — voitures, fourgons, camions
   Circulation strictement routière (pathfinding en mode 'road'),
   conduite à cap et vitesse continus, embarquement échelonné.
   ═══════════════════════════════════════════════════════ */

import { VEHICLE, ST, KIND } from './config.js';
import { dist, clamp, rand, wrapAngle } from './geo.js';

let NEXT_VID = 1;

export function makeVehicle(type, x, y, dir = 0) {
  const spec = VEHICLE[type];
  return {
    vid: NEXT_VID++,
    type, spec,
    variant: (Math.random() * 6) | 0,   // teinte de carrosserie
    x, y, dir,
    v: 0,                      // vitesse instantanée (m/s)
    path: null, pathI: 0, pathT: 0,
    dest: null,                // {x,y} objectif courant
    onArrive: null,            // 'unload' | 'wait' | null
    occupants: [],
    driver: null,
    capacity: spec.seats,
    hp: spec.hp, alive: true,
    state: 'parked',           // parked | driving | loading | unloading | wreck
    loadT: 0,
    ammo: spec.ammo || 0,
    stuckT: 0,
    horn: 0,
  };
}

export const vehicleFree = v => v.alive && !v.driver && v.state === 'parked';
export const seatsLeft = v => v.capacity - v.occupants.length;

/** Fait monter une entité (elle disparaît du monde tant qu'elle est à bord). */
export function embark(sim, e, v) {
  if (!v.alive || seatsLeft(v) <= 0) return false;
  if (e.vehicle) return false;
  v.occupants.push(e);
  e.vehicle = v;
  e.state = ST.ABOARD;
  e.path = null;
  e.indoor = false;
  if (!v.driver && e.kind !== KIND.ZOM) { v.driver = e; e.state = ST.DRIVING; }
  return true;
}

/** Débarque une entité à côté du véhicule. */
export function disembark(sim, e, v) {
  const i = v.occupants.indexOf(e);
  if (i >= 0) v.occupants.splice(i, 1);
  e.vehicle = null;
  if (v.driver === e) {
    v.driver = null;
    /* un autre passager prend le volant si le véhicule doit repartir */
    v.driver = v.occupants.find(o => o.alive) || null;
    if (v.driver) v.driver.state = ST.DRIVING;
  }
  const a = rand(0, Math.PI * 2);
  const spot = sim.grid.nearestFree(v.x + Math.cos(a) * (v.spec.half + 1.6),
                                   v.y + Math.sin(a) * (v.spec.half + 1.6), 10);
  const p = spot || sim.grid.nearestFree(v.x, v.y, 20) || { x: v.x, y: v.y };
  e.x = p.x; e.y = p.y;
  e.state = ST.IDLE;
  e.path = null;
  return true;
}

/** Ordonne un trajet. Renvoie false si la destination n'est pas joignable. */
export function driveTo(sim, v, x, y, onArrive = 'unload') {
  const road = sim.grid.nearestRoad(x, y, 60);
  if (!road) return false;
  if (sim.grid.roadCompAt(v.x, v.y) !== sim.grid.roadCompAt(road.x, road.y)) return false;
  v.dest = road;
  v.onArrive = onArrive;
  v.state = 'driving';
  v.path = null; v.pathT = 0;
  return true;
}

/* ═══ Mise à jour ═════════════════════════════════════ */
export function updateVehicle(sim, v, dt) {
  if (!v.alive) return;

  /* La chaussée peut disparaître sous le véhicule : une frappe la transforme
     en décombres, un barrage la coupe. Sans rattrapage, l'engin resterait
     immobilisé pour toujours à tenter d'avancer. */
  if (!sim.grid.driveable(v.x, v.y)) {
    const r = sim.grid.nearestRoad(v.x, v.y, 8);
    if (r) { v.x = r.x; v.y = r.y; v.v = 0; v.path = null; v.pathT = 1; }
    else {
      for (const o of v.occupants.slice()) disembark(sim, o, v);
      v.alive = false; v.state = 'wreck'; v.driver = null; v.v = 0;
      return;
    }
  }

  /* Plus de conducteur valide → le véhicule s'arrête et se gare */
  if (v.driver && (!v.driver.alive || v.driver.vehicle !== v)) v.driver = null;
  if (!v.driver) {
    v.driver = v.occupants.find(o => o.alive && o.kind !== KIND.ZOM) || null;
    if (v.driver) v.driver.state = ST.DRIVING;
  }

  if (v.state === 'loading') { v.v = decel(v.v, v.spec.brake, dt); return; }

  if (v.state !== 'driving' || !v.dest || !v.driver) {
    v.v = decel(v.v, v.spec.brake, dt);
    advance(sim, v, dt);
    return;
  }

  /* ── Chemin routier ── */
  v.pathT -= dt;
  const dToDest = dist(v.x, v.y, v.dest.x, v.dest.y);
  if (dToDest < 7) { arrive(sim, v); return; }

  if (!v.path && v.pathT <= 0) {
    v.pathT = 2.5;
    v.path = sim.roadPf.find(v.x, v.y, v.dest.x, v.dest.y, 30000);
    v.pathI = 0;
    if (!v.path) {                       // destination injoignable par la route
      v.state = 'parked'; v.dest = null; return;
    }
  }
  if (!v.path) { v.v = decel(v.v, v.spec.brake, dt); return; }

  while (v.pathI < v.path.length && dist(v.x, v.y, v.path[v.pathI].x, v.path[v.pathI].y) < 6)
    v.pathI++;
  if (v.pathI >= v.path.length) { arrive(sim, v); return; }

  const wp = v.path[v.pathI];
  const want = Math.atan2(wp.y - v.y, wp.x - v.x);
  const err = wrapAngle(want - v.dir);

  /* Braquage limité : un camion ne pivote pas sur place */
  const turn = clamp(err, -v.spec.turn * dt, v.spec.turn * dt);
  v.dir = wrapAngle(v.dir + turn);

  /* Vitesse cible : on ralentit dans les virages et devant un obstacle */
  let target = v.spec.speed * (1 - Math.min(0.75, Math.abs(err) / 1.6));
  target *= obstacleFactor(sim, v);
  v.v = v.v < target ? Math.min(target, v.v + v.spec.accel * dt)
                     : Math.max(target, v.v - v.spec.brake * dt);

  advance(sim, v, dt);

  /* Blocage prolongé → on recalcule l'itinéraire */
  if (v.v < 0.4) {
    v.stuckT += dt;
    if (v.stuckT > 3) { v.stuckT = 0; v.path = null; v.pathT = 1.5; }
    /* …et si rien n'y fait, on abandonne le véhicule. Quand des dizaines de
       voitures convergent vers le même point, elles se bloquent les unes les
       autres et le bouchon ne se résorbe jamais : les occupants restaient
       prisonniers indéfiniment. Au bout d'un moment, on descend et on finit
       le trajet à pied. */
    v.jamT = (v.jamT || 0) + dt;
    if (v.jamT > 14 && v.occupants.length) {
      v.jamT = 0; v.path = null; v.dest = null;
      v.state = 'unloading'; v.loadT = 0;
    }
  } else { v.stuckT = 0; v.jamT = 0; }
}

function decel(v, brake, dt) { return Math.max(0, v - brake * dt); }

/** Déplace le véhicule et écrase ce qui se trouve devant lui. */
function advance(sim, v, dt) {
  if (v.v <= 0.01) return;
  const nx = v.x + Math.cos(v.dir) * v.v * dt;
  const ny = v.y + Math.sin(v.dir) * v.v * dt;

  if (!sim.grid.driveable(nx, ny)) {
    /* On a mordu hors de la chaussée : on s'arrête. Surtout NE PAS relancer un
       calcul d'itinéraire ici — un véhicule coincé contre un bord déclenchait
       alors un A* routier à chaque tick. La détection de blocage s'en charge,
       avec un délai. */
    v.v = 0;
    return;
  }
  v.x = nx; v.y = ny;

  /* Écrasement : tout ce qui est happé par la calandre */
  if (v.v > 4) {
    const fx = v.x + Math.cos(v.dir) * v.spec.half * 0.7;
    const fy = v.y + Math.sin(v.dir) * v.spec.half * 0.7;
    sim.hash.query(fx, fy, v.spec.half * 0.9, (e) => {
      if (!e.alive || e.vehicle) return;
      if (e.kind === KIND.ZOM) {
        sim.damage(e, 45 + v.v * 12, null);
        sim.addBlood(e.x, e.y, 1.4);
        v.v *= 0.93;
      } else if (v.v > 9) {                  // on renverse aussi les piétons
        sim.damage(e, 30 + v.v * 6, null);
        sim.addBlood(e.x, e.y, 0.8);
      }
    });
  }
}

/** Facteur de vitesse selon ce qui encombre la route devant. */
function obstacleFactor(sim, v) {
  const look = Math.max(8, v.v * 1.6);
  const fx = v.x + Math.cos(v.dir) * look;
  const fy = v.y + Math.sin(v.dir) * look;

  /* Chaussée coupée (barrage, décombres) */
  if (!sim.grid.driveable(fx, fy)) return 0;

  /* Autre véhicule devant — une épave bloque tout autant qu'un véhicule */
  for (const o of sim.vehicles) {
    if (o === v) continue;
    const d = dist(v.x, v.y, o.x, o.y);
    if (d > look + o.spec.half) continue;
    const a = Math.abs(wrapAngle(Math.atan2(o.y - v.y, o.x - v.x) - v.dir));
    if (a < 0.7) return d < v.spec.half + o.spec.half + 2 ? 0 : 0.35;
  }
  return 1;
}

function arrive(sim, v) {
  v.path = null;
  v.dest = null;
  v.v = 0;
  if (v.onArrive === 'escape') v.state = 'escaped';       // traité par la simulation
  else if (v.onArrive === 'unload') { v.state = 'unloading'; v.loadT = 0; }
  else v.state = 'parked';
}

/** Fait descendre les passagers un par un. */
export function updateUnloading(sim, v, dt) {
  v.loadT -= dt;
  if (v.loadT > 0) return;
  v.loadT = 0.6;
  const e = v.occupants.find(o => o.alive);
  if (!e) { v.state = 'parked'; return; }
  disembark(sim, e, v);
}
