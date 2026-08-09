/* ═══════════════════════════════════════════════════════
   commander.js — commandement militaire
   Un officier présent sur le terrain coordonne les escouades :
   il établit la base, déclenche les évacuations, ordonne barrages,
   frappes et largages. Sa doctrine est ici entièrement locale ;
   ai-command.js peut la remplacer par un LLM.
   S'il meurt, plus personne ne donne d'ordres.
   ═══════════════════════════════════════════════════════ */

import { COMMANDER, KIND, ST, ORDER, THREAT, SQUAD, WEAPON } from './config.js';
import { makeEntity, giveWeapon } from './entities.js';
import { dist, dist2, clamp, rand } from './geo.js';

/* ═══ Mise en place ═══════════════════════════════════ */

export function initCommand(sim) {
  sim.command = {
    officer: null,
    think: 0,
    log: [],
    assets: {
      heli:   { ready: COMMANDER.assets.heli.max,   cd: 0 },
      strike: { ready: COMMANDER.assets.strike.max, cd: 0 },
      drop:   { ready: COMMANDER.assets.drop.max,   cd: 0 },
    },
    ai: { enabled: false, busy: false, lastError: null, calls: 0, nextT: 0 },
  };
}

/** Fait apparaître le commandant, rattaché à l'escouade la plus proche. */
export function spawnCommander(sim) {
  const pos = sim.randomFreePoint(true);
  if (!pos) return null;
  const e = makeEntity(KIND.MIL, pos.x, pos.y, { weapon: 'smg' });
  e.commander = true;
  e.hp = e.maxHp = COMMANDER.hp;
  e.skill = 0.8;
  e.state = ST.PATROL;
  sim.add(e);
  sim.command.officer = e;

  /* Il prend la tête de l'escouade la plus proche : le PC est mobile. */
  const sq = sim.squads
    .filter(s => s.kind === KIND.MIL && s.leader)
    .sort((a, b) => dist2(a.leader.x, a.leader.y, e.x, e.y) - dist2(b.leader.x, b.leader.y, e.x, e.y))[0];
  if (sq) {
    sq.members.unshift(e);
    sq.leader = e;
    e.squad = sq;
    e.x = sq.members[1] ? sq.members[1].x : e.x;
    e.y = sq.members[1] ? sq.members[1].y : e.y;
  }
  logCommand(sim, 'Poste de commandement établi.', 'info');
  return e;
}

export const commanderAlive = sim =>
  !!(sim.command && sim.command.officer && sim.command.officer.alive);

/* ═══ Journal ═════════════════════════════════════════ */
export function logCommand(sim, text, kind = 'order') {
  const log = sim.command.log;
  log.push({ t: sim.time, text, kind });
  if (log.length > COMMANDER.logMax) log.shift();
}

/* ═══ Boucle ══════════════════════════════════════════ */
export function updateCommand(sim, dt) {
  const C = sim.command;
  if (!C) return;

  /* Reconstitution des moyens, même sans commandant */
  for (const key of Object.keys(C.assets)) {
    const a = C.assets[key], spec = COMMANDER.assets[key];
    if (a.ready >= spec.max) continue;
    a.cd -= dt;
    if (a.cd <= 0) { a.ready++; a.cd = spec.reload; }
  }

  if (!commanderAlive(sim)) {
    if (C.officer && !C._deathLogged) {
      C._deathLogged = true;
      logCommand(sim, 'Commandant hors de combat — les escouades reprennent leur initiative.', 'alert');
    }
    return;
  }

  C.think -= dt;
  if (C.think > 0) return;
  C.think = COMMANDER.think;

  /* Le LLM, quand il est branché, remplace la doctrine locale. Il est
     interrogé de façon asynchrone : la simulation ne l'attend jamais. */
  if (C.ai.enabled && sim.requestAIOrders) {
    if (sim.time >= C.ai.nextT && !C.ai.busy) sim.requestAIOrders();
    return;
  }
  doctrine(sim);
}

/* ═══ Doctrine locale ═════════════════════════════════ */
function doctrine(sim) {
  const C = sim.command, cmd = C.officer;

  /* 1 — Sans base, en établir une : secteur calme, desservi par la route. */
  if (!sim.base) {
    const spot = baseSite(sim, cmd);
    if (spot && sim.setBase(spot.x, spot.y)) {
      logCommand(sim, `Base établie à ${fmt(spot)} — point de regroupement des civils.`);
      return;
    }
  }

  /* 2 — Frappe sur une concentration de zombies, loin de tout ami. */
  if (C.assets.strike.ready > 0) {
    const t = strikeTarget(sim);
    if (t) {
      sim.callStrike(t.x, t.y);
      spend(C, 'strike');
      logCommand(sim, `Frappe demandée sur ${fmt(t)} — ${t.zombies} hostiles, aucun ami à proximité.`);
      return;
    }
  }

  /* 3 — Évacuation d'un gros groupe de civils hors de portée de la base. */
  if (C.assets.heli.ready > 0 && !sim.activeHeli()) {
    const z = evacTarget(sim);
    if (z && sim.callHeli(z.x, z.y)) {
      spend(C, 'heli');
      logCommand(sim, `Hélicoptère dérouté sur ${fmt(z)} — ${z.civilians} civils à extraire.`);
      return;
    }
  }

  /* 4 — Ravitaillement d'une escouade à sec et éloignée. */
  if (C.assets.drop.ready > 0) {
    const sq = drySquad(sim);
    if (sq) {
      sim.callDrop(sq.leader.x, sq.leader.y);
      spend(C, 'drop');
      logCommand(sim, `Largage sur la position de l'escouade ${sq.sid} — munitions au plus bas.`);
      return;
    }
  }

  /* 5 — Barrage sur l'axe par lequel arrivent les zombies. */
  if (sim.blockades.filter(b => !b.built).length === 0) {
    const road = blockadeSite(sim);
    if (road && sim.orderBlockadeAt(road.x, road.y)) {
      logCommand(sim, `Barrage ordonné sur l'axe en ${fmt(road)} — voie d'approche des hostiles.`);
      return;
    }
  }

  /* 6 — Base menacée : on rappelle l'escouade la plus proche. */
  if (sim.base && sim.threatAt(sim.base.x, sim.base.y) > 3) {
    const sq = sim.squads
      .filter(s => s.leader && s.order?.type !== ORDER.GARRISON)
      .sort((a, b) => dist2(a.leader.x, a.leader.y, sim.base.x, sim.base.y)
                    - dist2(b.leader.x, b.leader.y, sim.base.x, sim.base.y))[0];
    if (sq) {
      sq.order = { type: ORDER.GARRISON };
      sq.prevOrder = null;
      logCommand(sim, `Base sous pression — escouade ${sq.sid} rappelée en défense.`, 'alert');
    }
  }
}

const spend = (C, key) => {
  const a = C.assets[key];
  a.ready--;
  if (a.cd <= 0) a.cd = COMMANDER.assets[key].reload;
};

const fmt = p => `${Math.round(p.x)}/${Math.round(p.y)}`;

/* ═══ Analyse de situation ════════════════════════════ */

/** Emplacement de base : calme, sur la voirie principale, près des civils. */
function baseSite(sim, cmd) {
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 90; i++) {
    const a = rand(0, Math.PI * 2), r = rand(30, 450);
    const x = clamp(cmd.x + Math.cos(a) * r, 10, sim.frame.width - 10);
    const y = clamp(cmd.y + Math.sin(a) * r, 10, sim.frame.height - 10);
    if (!sim.grid.inMainComponent(x, y)) continue;
    const threat = sim.threatAt(x, y);
    if (threat > COMMANDER.baseMaxThreat) continue;
    const road = sim.grid.nearestRoad(x, y, 25) ? 1 : 0;
    let civ = 0;
    sim.queryBuildings(x, y, 220, (b) => { civ += b.occupants.length; });
    const score = civ * 0.08 + road * 3 - threat * 2 - dist(cmd.x, cmd.y, x, y) / 200;
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return best;
}

/** Concentration de zombies sans ami à proximité. */
function strikeTarget(sim) {
  const t = sim.threat, cell = THREAT.cell;
  let best = null, bestN = COMMANDER.strikeMinZombies;
  for (let cy = 0; cy < sim.th; cy++) {
    for (let cx = 0; cx < sim.tw; cx++) {
      if (t[cy * sim.tw + cx] < bestN * 0.5) continue;
      const x = (cx + 0.5) * cell, y = (cy + 0.5) * cell;
      let zom = 0, friend = 0;
      sim.hash.query(x, y, COMMANDER.strikeSafeRadius, (e) => {
        if (!e.alive) return;
        if (e.kind === KIND.ZOM) { if (dist(e.x, e.y, x, y) < sim.params.strikeRadius) zom++; }
        else friend++;
      });
      if (friend > 0) continue;
      /* On n'écrase pas non plus un bâtiment encore habité. */
      let occupants = 0;
      sim.queryBuildings(x, y, sim.params.strikeRadius, (b) => { occupants += b.occupants.length; });
      if (occupants > 0) continue;
      if (zom > bestN) { bestN = zom; best = { x, y, zombies: zom }; }
    }
  }
  return best;
}

/** Attroupement de civils que la base ne peut pas absorber. */
function evacTarget(sim) {
  let best = null, bestN = COMMANDER.evacMinCivilians;
  const seen = new Set();
  for (const e of sim.entities) {
    if (e.kind !== KIND.CIV || !e.alive || e.indoor || e.vehicle) continue;
    if (seen.has(e.id)) continue;
    if (sim.base && dist(e.x, e.y, sim.base.x, sim.base.y) < 220) continue;
    let n = 0;
    sim.hash.query(e.x, e.y, 60, (o) => {
      if (o.kind === KIND.CIV && o.alive && !o.indoor && !o.vehicle) { n++; seen.add(o.id); }
    });
    if (n > bestN) { bestN = n; best = { x: e.x, y: e.y, civilians: n }; }
  }
  return best;
}

/** Escouade à court de munitions, loin de toute source. */
function drySquad(sim) {
  for (const sq of sim.squads) {
    if (!sq.leader) continue;
    const n = sq.members.length || 1;
    const ammo = sq.members.reduce((a, m) => a + m.mag + m.reserve, 0) / n;
    if (ammo > COMMANDER.lowAmmoDrop) continue;
    const src = sim.resupplyPoint(sq.leader.x, sq.leader.y);
    if (src && dist(sq.leader.x, sq.leader.y, src.x, src.y) < 180) continue;
    return sq;
  }
  return null;
}

/** Axe routier le plus emprunté par les hostiles. */
function blockadeSite(sim) {
  let best = null, bestScore = 6;
  for (let i = 0; i < 60; i++) {
    const e = sim.entities[(Math.random() * sim.entities.length) | 0];
    if (!e || e.kind !== KIND.ZOM || !e.alive) continue;
    const road = sim.grid.nearestRoad(e.x, e.y, 20);
    if (!road) continue;
    if (sim.blockades.some(b => dist(b.x, b.y, road.x, road.y) < 90)) continue;
    if (sim.base && dist(road.x, road.y, sim.base.x, sim.base.y) > 500) continue;
    const score = sim.threatAt(road.x, road.y);
    if (score > bestScore) { bestScore = score; best = road; }
  }
  return best;
}

/* ═══ Exécution d'un ordre (doctrine locale ou LLM) ═══ */

const clampPos = (sim, p) => ({
  x: clamp(+p.x || 0, 2, sim.frame.width - 2),
  y: clamp(+p.y || 0, 2, sim.frame.height - 2),
});

/**
 * Applique un ordre décrit en JSON. Toute entrée est traitée comme
 * potentiellement invalide : un ordre incohérent est rejeté avec un motif,
 * jamais appliqué de force.
 */
export function executeOrder(sim, order) {
  if (!order || typeof order !== 'object') return { ok: false, text: 'ordre illisible' };
  const C = sim.command;
  const type = String(order.type || '').toLowerCase();
  const p = clampPos(sim, order);

  const squadOf = () => sim.squads.find(s => s.sid === (order.escouade ?? order.squad));

  switch (type) {
    case 'base':
      if (sim.base) return { ok: false, text: 'base déjà établie' };
      if (!sim.setBase(p.x, p.y)) return { ok: false, text: 'emplacement de base impraticable' };
      return { ok: true, text: `Base établie à ${fmt(p)}.` };

    case 'evac':
      if (C.assets.heli.ready <= 0) return { ok: false, text: 'aucun hélicoptère disponible' };
      if (sim.activeHeli()) return { ok: false, text: 'un hélicoptère est déjà engagé' };
      if (!sim.callHeli(p.x, p.y)) return { ok: false, text: 'aucune zone de poser à cet endroit' };
      spend(C, 'heli');
      return { ok: true, text: `Évacuation héliportée sur ${fmt(p)}.` };

    case 'frappe': case 'strike': {
      if (C.assets.strike.ready <= 0) return { ok: false, text: 'aucune frappe disponible' };
      /* Garde-fou : on ne bombarde jamais ses propres troupes ni des civils. */
      let friend = 0;
      sim.hash.query(p.x, p.y, sim.params.strikeRadius * 1.2, (e) => {
        if (e.alive && e.kind !== KIND.ZOM) friend++;
      });
      let occupants = 0;
      sim.queryBuildings(p.x, p.y, sim.params.strikeRadius, (b) => { occupants += b.occupants.length; });
      if (friend + occupants > 0)
        return { ok: false, text: `frappe refusée sur ${fmt(p)} : ${friend + occupants} amis dans le rayon` };
      sim.callStrike(p.x, p.y);
      spend(C, 'strike');
      return { ok: true, text: `Frappe sur ${fmt(p)}.` };
    }

    case 'largage': case 'drop':
      if (C.assets.drop.ready <= 0) return { ok: false, text: 'aucun largage disponible' };
      sim.callDrop(p.x, p.y);
      spend(C, 'drop');
      return { ok: true, text: `Largage de munitions sur ${fmt(p)}.` };

    case 'barrage': case 'blockade':
      if (!sim.orderBlockadeAt(p.x, p.y)) return { ok: false, text: 'pas de route exploitable ici' };
      return { ok: true, text: `Barrage ordonné en ${fmt(p)}.` };

    case 'ratissage': case 'sweep': {
      const sq = squadOf();
      if (sq) { sq.order = { type: ORDER.SWEEP, x: p.x, y: p.y }; sq.prevOrder = null; sq.anchor = p; }
      else if (!sim.orderSweep(p.x, p.y)) return { ok: false, text: 'aucune escouade disponible' };
      return { ok: true, text: `Ratissage de ${fmt(p)}.` };
    }

    case 'escorte': case 'escort': {
      const sq = squadOf();
      if (!sq) return { ok: false, text: 'escouade inconnue' };
      sq.order = { type: ORDER.ESCORT, dest: p };
      sq.prevOrder = null;
      return { ok: true, text: `Escouade ${sq.sid} en escorte vers ${fmt(p)}.` };
    }

    case 'garnison': case 'garrison': {
      const sq = squadOf();
      if (!sq) return { ok: false, text: 'escouade inconnue' };
      if (!sim.base) return { ok: false, text: 'aucune base à tenir' };
      sq.order = { type: ORDER.GARRISON };
      sq.prevOrder = null;
      return { ok: true, text: `Escouade ${sq.sid} en défense de la base.` };
    }

    case 'patrouille': case 'patrol': {
      const sq = squadOf();
      const half = clamp(+order.rayon || 90, 30, 400);
      const rect = {
        x0: clamp(p.x - half, 0, sim.frame.width), x1: clamp(p.x + half, 0, sim.frame.width),
        y0: clamp(p.y - half, 0, sim.frame.height), y1: clamp(p.y + half, 0, sim.frame.height),
      };
      if (sq) { sq.order = { type: ORDER.PATROL, rect }; sq.prevOrder = null; sq.anchor = sim.randomPointInRect(rect); }
      else if (!sim.assignPatrol(rect, [KIND.MIL, KIND.POL], 1)) return { ok: false, text: 'aucune escouade disponible' };
      return { ok: true, text: `Patrouille autour de ${fmt(p)}.` };
    }

    case 'libre': case 'free': {
      const sq = squadOf();
      if (!sq) return { ok: false, text: 'escouade inconnue' };
      sq.order = null; sq.prevOrder = null;
      return { ok: true, text: `Escouade ${sq.sid} rendue à son initiative.` };
    }

    default:
      return { ok: false, text: `ordre inconnu « ${type} »` };
  }
}

/* ═══ Compte rendu de situation ═══════════════════════
   Vue compacte du terrain, destinée au LLM. Coordonnées en mètres.
   ═══════════════════════════════════════════════════ */
export function situationReport(sim) {
  const f = sim.frame, C = sim.command;
  const r = n => Math.round(n);

  const squads = sim.squads.filter(s => s.leader).map(s => ({
    id: s.sid,
    hommes: s.members.length,
    position: [r(s.leader.x), r(s.leader.y)],
    mission: s.order ? s.order.type : 'initiative',
    civils_encadres: s.escorted.filter(c => c.alive).length,
    cartouches_par_homme: Math.round(
      s.members.reduce((a, m) => a + m.mag + m.reserve, 0) / Math.max(1, s.members.length)),
  }));

  /* Foyers de menace : les cellules les plus chaudes de la carte */
  const hot = [];
  for (let cy = 0; cy < sim.th; cy++) {
    for (let cx = 0; cx < sim.tw; cx++) {
      const v = sim.threat[cy * sim.tw + cx];
      if (v > 2) hot.push({ position: [r((cx + .5) * THREAT.cell), r((cy + .5) * THREAT.cell)], intensite: +v.toFixed(1) });
    }
  }
  hot.sort((a, b) => b.intensite - a.intensite);

  /* Poches de civils : bâtiments encore habités */
  const pockets = [];
  for (const b of sim.buildings) {
    if (!b.occupants.length || b.destroyed) continue;
    pockets.push({ position: [r(b.c.x), r(b.c.y)], civils: b.occupants.length,
                   menace: +sim.threatAt(b.c.x, b.c.y).toFixed(1) });
  }
  pockets.sort((a, b) => b.civils - a.civils);

  return {
    zone: { largeur: r(f.width), hauteur: r(f.height) },
    temps_ecoule_s: r(sim.time),
    effectifs: {
      civils_dehors: sim.entities.filter(e => e.kind === KIND.CIV && e.alive && !e.indoor && !e.vehicle).length,
      civils_abrites: sim.entities.filter(e => e.kind === KIND.CIV && e.alive && e.indoor).length,
      militaires: sim.stats.mil, gendarmes: sim.stats.pol, zombies: sim.stats.zom,
      evacues: sim.stats.evac, morts: sim.stats.dead,
    },
    base: sim.base ? { position: [r(sim.base.x), r(sim.base.y)], rayon: sim.base.r } : null,
    moyens_disponibles: {
      helicopteres: C.assets.heli.ready,
      frappes: C.assets.strike.ready,
      largages: C.assets.drop.ready,
      rayon_frappe_m: sim.params.strikeRadius,
    },
    escouades: squads,
    foyers_hostiles: hot.slice(0, 6),
    poches_de_civils: pockets.slice(0, 6),
    barrages: sim.blockades.map(b => ({ position: [r(b.x), r(b.y)], monte: !!b.built })),
    helicoptere_en_cours: !!sim.activeHeli(),
  };
}
