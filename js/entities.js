/* ═══════════════════════════════════════════════════════
   entities.js — fabrique et helpers d'entités
   ═══════════════════════════════════════════════════════ */

import { KIND, UNIT, WEAPON, ST, SKILL } from './config.js';
import { rand } from './geo.js';

let NEXT_ID = 1;

export function makeEntity(kind, x, y, opts = {}) {
  const u = UNIT[kind];
  const e = {
    id: NEXT_ID++,
    kind,
    x, y,
    vx: 0, vy: 0,
    dir: rand(-Math.PI, Math.PI),
    variant: (Math.random() * 8) | 0,   // teinte de vêtement (voir sprites.js)
    hp: u.hp, maxHp: u.hp,
    alive: true,
    state: ST.IDLE,

    /* mouvement */
    baseSpeed: u.speed,
    runSpeed: u.run,
    radius: u.radius,
    path: null, pathI: 0, pathT: 0, pathGoal: null, pathFails: 0,
    field: null,                 // flow-field partagé éventuel
    stuckT: 0, lastX: x, lastY: y,
    wanderT: 0, wx: 0, wy: 0,

    /* endurance (les zombies n'en ont pas : ils ne se fatiguent jamais) */
    stamina: 1,
    blown: false,        // à bout de souffle : marche forcée jusqu'à récupération
    restT: 0,            // temps de souffle avant que la récupération démarre

    /* perception */
    sight: u.sight, fov: u.fov,
    senseT: Math.random() * 0.5,
    losT: Math.random() * 0.35,
    target: null,
    heardX: 0, heardY: 0, heardT: 0,
    alert: 0,                    // 0..1 : niveau d'éveil / panique

    /* combat */
    weapon: opts.weapon ?? null,
    mag: 0, reserve: 0,
    fireT: 0, reloadT: 0, burst: 0,
    skill: SKILL[kind] ?? 0.4,
    kills: 0,

    /* zombie */
    zType: opts.zType ?? null,   // 'slow' | 'fast'
    biteT: 0,
    feedT: 0,

    /* infection */
    infected: false, turnT: 0,

    /* civils */
    home: opts.home ?? null,
    indoor: false,
    boardT: 0, heli: null,

    /* militaires */
    patrol: null, patrolWP: null, patrolT: 0, order: null,

    ...opts,
  };
  if (e.weapon) giveWeapon(e, e.weapon);
  return e;
}

export function giveWeapon(e, key, magsBonus = 0) {
  const w = WEAPON[key];
  if (!w) return;
  e.weapon = key;
  e.mag = w.mag;
  e.reserve = w.reserve + magsBonus * w.mag;
  e.reloadT = 0;
}

export function addAmmo(e, mags = 3) {
  const w = WEAPON[e.weapon];
  if (!w) return false;
  e.reserve += w.mag * mags;
  return true;
}

export const isHuman = e => e.kind !== KIND.ZOM;
export const isArmed = e => !!e.weapon && (e.mag > 0 || e.reserve > 0);
export const isFighter = e => e.kind === KIND.POL || e.kind === KIND.MIL;

/** Cible “vivante et attaquable” pour un zombie. */
export const isPrey = e =>
  e.kind !== KIND.ZOM && e.alive && !e.indoor &&
  e.state !== ST.EVACUATED && e.state !== ST.DEAD;

/** Cible pour les humains armés. */
export const isThreat = e => e.kind === KIND.ZOM && e.alive;

export function totalAmmo(e) {
  return e.mag + e.reserve;
}
