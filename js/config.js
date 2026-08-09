/* ═══════════════════════════════════════════════════════
   config.js — toutes les constantes de réglage du moteur
   ═══════════════════════════════════════════════════════ */

export const CFG = {
  /* ── Grille de navigation ── */
  CELL: 2,                  // mètres par cellule
  MAX_ZONE_M: 4000,         // côté max d'une zone (garde-fou perfs)

  /* ── Boucle de simulation ── */
  TICK: 1 / 20,             // pas fixe : 20 Hz
  MAX_STEPS_PER_FRAME: 12,  // anti spirale de la mort

  /* ── Budget pathfinding (par tick) ── */
  PATH_BUDGET: 28,          // nb max de A* calculés par tick
  PATH_MAX_NODES: 30000,    // expansions max d'un A*
  PATH_REFRESH: 1.4,        // s entre deux recalculs pour une même entité

  /* ── Perception ── */
  LOS_REFRESH: 0.35,        // s entre deux tests de vision
  SENSE_REFRESH: 0.5,       // s entre deux acquisitions de cible

  /* ── Bruit (rayon d'attraction en m) ── */
  NOISE: {
    pistol: 130, rifle: 190, scream: 70,
    heli: 320, explosion: 550, crate: 90,
  },

  /* ── Estimation de population ── */
  POP: {
    /* m² de plancher BRUT par habitant : ~55 m² de logement + circulations,
       commerces en rez-de-chaussée et bureaux qui n'hébergent personne. */
    M2_PER_PERSON: 110,
    MAX_PER_BUILDING: 120,
    MIN_FOOTPRINT: 18,      // m² en dessous desquels un bâtiment est ignoré
    EMPTY_ZONE_DENSITY: 90, // civils/km² si aucun bâtiment (campagne)
  },

  /* ── Largeurs par défaut (m) pour les géométries linéaires OSM ── */
  WIDTH: {
    river: 22, stream: 5, canal: 12, ditch: 3, drain: 3,
    motorway: 18, trunk: 15, primary: 12, secondary: 10, tertiary: 8,
    residential: 7, unclassified: 6, service: 4, living_street: 6,
    footway: 2.5, path: 2, pedestrian: 5, track: 3, cycleway: 2.5,
    wall: 0.6, fence: 0.5, hedge: 1.2,
  },
};

/* Masques de bits de la grille */
export const T = {
  FREE:     0,
  BUILDING: 1 << 0,   // bloque déplacement + vue
  WATER:    1 << 1,   // bloque déplacement au sol
  WALL:     1 << 2,   // mur : bloque déplacement + vue
  FENCE:    1 << 3,   // clôture : bloque déplacement seulement
  ROAD:     1 << 4,   // bonus de vitesse, zone de spawn
  RUBBLE:   1 << 5,   // décombres : franchissable au ralenti
};
export const BLOCK_MOVE = T.BUILDING | T.WATER | T.WALL | T.FENCE;
export const BLOCK_SIGHT = T.BUILDING | T.WALL;

/* ── Fiches d'unités ─────────────────────────────────── */
export const KIND = { CIV: 0, POL: 1, MIL: 2, ZOM: 3 };

export const UNIT = {
  [KIND.CIV]: {
    name: 'Civil', color: '#ffd45e', radius: 0.42,
    speed: 1.35, run: 3.4, hp: 100,
    sight: 55, fov: 2.4, courage: 0.05,
  },
  [KIND.POL]: {
    name: 'Gendarme', color: '#4ea1ff', radius: 0.45,
    speed: 1.55, run: 3.3, hp: 110,
    sight: 90, fov: 2.6, courage: 0.55,
  },
  [KIND.MIL]: {
    name: 'Militaire', color: '#7ee787', radius: 0.46,
    speed: 1.5, run: 3.1, hp: 130,
    sight: 130, fov: 2.8, courage: 0.85,
  },
  [KIND.ZOM]: {
    name: 'Zombie', color: '#9d5cf0', radius: 0.44,
    speed: 0.8, run: 0.8, hp: 70,
    sight: 45, fov: 3.6, courage: 1,
    bite: { dps: 42, reach: 0.95, cooldown: 0.8 },
  },
};

/* ── Armes ───────────────────────────────────────────── */
export const WEAPON = {
  none:   null,
  pistol: { name:'Pistolet', dmg:26, rpm:220, mag:15,  reserve:60,  range:45,  reload:2.2, spread:0.055, noise:'pistol', auto:false, hs:0.10 },
  smg:    { name:'PM',       dmg:24, rpm:750, mag:30,  reserve:180, range:70,  reload:2.6, spread:0.075, noise:'rifle',  auto:true,  hs:0.08 },
  rifle:  { name:'Fusil',    dmg:38, rpm:600, mag:30,  reserve:210, range:140, reload:2.9, spread:0.032, noise:'rifle',  auto:true,  hs:0.16 },
  shotgun:{ name:'Fusil à pompe', dmg:70, rpm:70, mag:6, reserve:40, range:28, reload:4.2, spread:0.13, noise:'rifle', auto:false, hs:0.22 },
  lmg:    { name:'Mitrailleuse', dmg:36, rpm:800, mag:100, reserve:400, range:160, reload:6.5, spread:0.06, noise:'rifle', auto:true, hs:0.10 },
};

/* Compétence de tir par type d'unité (0..1) */
export const SKILL = { [KIND.CIV]: 0.32, [KIND.POL]: 0.68, [KIND.MIL]: 0.88 };

/* ── États d'IA ──────────────────────────────────────── */
export const ST = {
  IDLE:0, WANDER:1, FLEE:2, SEEK:3, ATTACK:4, PATROL:5,
  INDOOR:6, BOARD:7, EVACUATED:8, DOWNED:9, TURNING:10,
  FEED:11, GOTO:12, DEAD:13, RESUPPLY:14,
};
