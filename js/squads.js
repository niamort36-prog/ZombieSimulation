/* ═══════════════════════════════════════════════════════
   squads.js — commandement des forces armées
   Les combattants ne décident plus individuellement : l'escouade
   porte l'ordre, choisit la destination sûre, et ses membres
   tiennent une formation autour du chef.
   ═══════════════════════════════════════════════════════ */

import { SQUAD, ORDER, KIND, ST, WEAPON, BLOCKADE } from './config.js';
import { dist, dist2, clamp, rand } from './geo.js';

let NEXT_SID = 1;

export function makeSquad(kind, members = []) {
  const sq = {
    sid: NEXT_SID++,
    kind,                       // KIND.MIL ou KIND.POL
    members,
    leader: members[0] || null,
    order: null,                // {type, ...}
    prevOrder: null,
    escorted: [],               // civils pris en charge
    anchor: null,               // point vers lequel l'escouade progresse
    buildT: 0,
    think: 0,
    vehicle: null,
  };
  members.forEach((m, i) => { m.squad = sq; m.slot = i; });
  return sq;
}

/** Répartit les combattants sans escouade en groupes cohérents. */
export function formSquads(sim) {
  for (const kind of [KIND.MIL, KIND.POL]) {
    const size = kind === KIND.MIL ? SQUAD.milSize : SQUAD.polSize;
    const pool = sim.entities.filter(e => e.alive && e.kind === kind && !e.squad);
    /* On regroupe par proximité : les plus proches partent ensemble. */
    while (pool.length) {
      const seed = pool.shift();
      const group = [seed];
      pool.sort((a, b) => dist2(a.x, a.y, seed.x, seed.y) - dist2(b.x, b.y, seed.x, seed.y));
      while (group.length < size && pool.length) group.push(pool.shift());
      sim.squads.push(makeSquad(kind, group));
    }
  }
}

export function squadAmmo(sq) {
  let total = 0, n = 0;
  for (const m of sq.members) {
    if (!m.alive) continue;
    total += m.mag + m.reserve; n++;
  }
  return n ? total / n : 0;
}

/** Position que doit tenir un équipier, en fonction de l'ordre en cours. */
export function slotPosition(sq, e) {
  const L = sq.leader;
  if (!L || L === e) return null;
  const i = Math.max(1, sq.members.indexOf(e));
  const s = SQUAD.spacing;

  /* En escorte, l'escouade forme un anneau autour du groupe de civils. */
  if (sq.order && sq.order.type === ORDER.ESCORT && sq.escorted.length) {
    const c = escortCentroid(sq);
    const n = Math.max(1, sq.members.filter(m => m.alive).length);
    const a = (i / n) * Math.PI * 2;
    const r = clamp(8 + sq.escorted.length * 0.5, 9, 26);
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
  }

  /* Sinon : colonne en V derrière le chef. */
  const side = (i % 2 === 0) ? 1 : -1;
  const rank = Math.ceil(i / 2);
  const back = -Math.cos(L.dir) * rank * s - Math.cos(L.dir + Math.PI / 2) * side * s * 0.75;
  const lat = -Math.sin(L.dir) * rank * s - Math.sin(L.dir + Math.PI / 2) * side * s * 0.75;
  return { x: L.x + back, y: L.y + lat };
}

export function escortCentroid(sq) {
  let x = 0, y = 0, n = 0;
  for (const c of sq.escorted) { if (!c.alive || c.vehicle) continue; x += c.x; y += c.y; n++; }
  if (!n) return sq.leader ? { x: sq.leader.x, y: sq.leader.y } : { x: 0, y: 0 };
  return { x: x / n, y: y / n };
}

/* ═══ Décisions d'escouade (2 Hz) ═════════════════════ */
export function updateSquads(sim, dt) {
  for (let i = sim.squads.length - 1; i >= 0; i--) {
    const sq = sim.squads[i];
    sq.members = sq.members.filter(m => m.alive);
    if (!sq.members.length) {
      for (const c of sq.escorted) if (c.escort === sq) c.escort = null;
      sim.squads.splice(i, 1);
      continue;
    }
    if (!sq.leader || !sq.leader.alive) sq.leader = sq.members[0];

    sq.think -= dt;
    if (sq.think > 0) continue;
    sq.think = 0.5;
    decide(sim, sq);
  }
}

function decide(sim, sq) {
  const L = sq.leader;

  /* ── Munitions basses : on rompt et on va se réapprovisionner ── */
  const ammo = squadAmmo(sq);
  if (ammo < SQUAD.lowAmmo && sq.order?.type !== ORDER.RESUPPLY) {
    const src = sim.resupplyPoint(L.x, L.y);
    if (src) {
      sq.prevOrder = sq.order;
      sq.order = { type: ORDER.RESUPPLY, x: src.x, y: src.y };
    }
  }
  if (sq.order?.type === ORDER.RESUPPLY) {
    if (ammo > SQUAD.lowAmmo * 4) {
      sq.order = sq.prevOrder || null;      // rechargé : on reprend la mission
      sq.prevOrder = null;
    } else {
      const src = sim.resupplyPoint(L.x, L.y);
      if (src) { sq.order.x = src.x; sq.order.y = src.y; sq.anchor = src; }
      else sq.order = sq.prevOrder || null;
      return;
    }
  }

  /* ── Ordre du joueur en cours ── */
  if (sq.order) {
    switch (sq.order.type) {
      case ORDER.BLOCKADE: sq.anchor = { x: sq.order.x, y: sq.order.y }; return;
      case ORDER.PATROL: {
        const r = sq.order.rect;
        if (!sq.anchor || dist(L.x, L.y, sq.anchor.x, sq.anchor.y) < 8)
          sq.anchor = sim.randomPointInRect(r);
        return;
      }
      case ORDER.SWEEP:
        sq.anchor = { x: sq.order.x, y: sq.order.y };
        if (dist(L.x, L.y, sq.order.x, sq.order.y) < 12) sq.order = null;
        return;
      case ORDER.GARRISON:
        sq.anchor = sim.base ? { x: sim.base.x, y: sim.base.y } : sq.anchor;
        gatherCivilians(sim, sq);
        return;
      case ORDER.ESCORT:
        runEscort(sim, sq);
        return;
    }
  }

  /* ── Sans ordre : comportement autonome — regrouper et mettre à l'abri ── */
  sq.order = { type: ORDER.ESCORT, dest: sim.safePoint(L.x, L.y) };
  runEscort(sim, sq);
}

/** Ramasse les civils autour de l'escouade et les conduit en lieu sûr. */
function runEscort(sim, sq) {
  const L = sq.leader;
  gatherCivilians(sim, sq);

  /* Destination : la base, sinon le secteur le plus calme accessible */
  let dest = sq.order.dest;
  if (!dest || sim.threatAt(dest.x, dest.y) > 2.5 || dist(L.x, L.y, dest.x, dest.y) < 15) {
    dest = sim.safePoint(L.x, L.y);
    sq.order.dest = dest;
  }
  if (!dest) { sq.anchor = null; return; }

  const alive = sq.escorted.filter(c => c.alive && !c.vehicle);
  if (!alive.length) {
    /* Personne à escorter : on va chercher du monde là où il y en a */
    const target = sim.civilianHotspot(L.x, L.y) || dest;
    sq.anchor = target;
    return;
  }

  /* On avance au rythme du groupe : le chef ne distance jamais ses civils */
  const c = escortCentroid(sq);
  const spread = Math.max(...alive.map(p => dist(p.x, p.y, c.x, c.y)), 0);
  sq.anchor = (spread > 35 || dist(L.x, L.y, c.x, c.y) > 30)
    ? c                                     // on attend / on resserre
    : dest;
}

/** Prend en charge les civils proches et libère ceux qui ont décroché. */
function gatherCivilians(sim, sq) {
  const L = sq.leader;
  sq.escorted = sq.escorted.filter(c =>
    c.alive && c.escort === sq && !c.indoor && dist(c.x, c.y, L.x, L.y) < 120);

  sim.hash.query(L.x, L.y, SQUAD.escortRadius, (e) => {
    if (e.kind !== KIND.CIV || !e.alive || e.indoor || e.vehicle) return;
    if (e.escort && e.escort !== sq) return;
    if (e.state === ST.EVACUATED) return;
    if (sq.escorted.length >= 40) return;
    if (!sq.escorted.includes(e)) { e.escort = sq; sq.escorted.push(e); }
  });
}

/* ═══ Ordres du joueur ════════════════════════════════ */

/** Escouades les plus proches d'un point, chef en vie. */
export function nearestSquads(sim, x, y, kinds, count = 1) {
  return sim.squads
    .filter(s => s.leader && kinds.includes(s.kind))
    .sort((a, b) => dist2(a.leader.x, a.leader.y, x, y) - dist2(b.leader.x, b.leader.y, x, y))
    .slice(0, count);
}

export function orderBlockade(sim, x, y) {
  const road = sim.grid.nearestRoad(x, y, 40);
  if (!road) return null;
  const sq = nearestSquads(sim, road.x, road.y, [KIND.MIL, KIND.POL], 1)[0];
  if (!sq) return null;
  const bl = { x: road.x, y: road.y, progress: 0, built: false, squad: sq };
  sim.blockades.push(bl);
  sq.order = { type: ORDER.BLOCKADE, x: road.x, y: road.y, bl };
  sq.prevOrder = null;
  return bl;
}
