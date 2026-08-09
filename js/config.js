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
  ROAD:     1 << 4,   // circulable, bonus de vitesse à pied
  RUBBLE:   1 << 5,   // décombres : franchissable au ralenti
  BLOCKADE: 1 << 6,   // barrage : infranchissable en véhicule, escaladable à pied
};
export const BLOCK_MOVE = T.BUILDING | T.WATER | T.WALL | T.FENCE;
export const BLOCK_SIGHT = T.BUILDING | T.WALL;
/* Un véhicule ne roule que sur la voirie, et un barrage l'arrête net. */
export const BLOCK_DRIVE = BLOCK_MOVE | T.BLOCKADE | T.RUBBLE;

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
/* `reserve` = cartouches hors chargeur. Dotation de référence d'un militaire :
   30 en chargeur + 270 en réserve = 300 cartouches, à reconstituer à la base,
   auprès d'un camion de ravitaillement ou par parachutage. */
export const WEAPON = {
  none:   null,
  pistol: { name:'Pistolet', dmg:26, rpm:220, mag:15,  reserve:105, range:45,  reload:2.2, spread:0.055, noise:'pistol', auto:false, hs:0.10 },
  smg:    { name:'PM',       dmg:24, rpm:750, mag:30,  reserve:270, range:70,  reload:2.6, spread:0.075, noise:'rifle',  auto:true,  hs:0.08 },
  rifle:  { name:'Fusil',    dmg:38, rpm:600, mag:30,  reserve:270, range:140, reload:2.9, spread:0.032, noise:'rifle',  auto:true,  hs:0.16 },
  shotgun:{ name:'Fusil à pompe', dmg:70, rpm:70, mag:6, reserve:54, range:28, reload:4.2, spread:0.13, noise:'rifle', auto:false, hs:0.22 },
  lmg:    { name:'Mitrailleuse', dmg:36, rpm:800, mag:100, reserve:500, range:160, reload:6.5, spread:0.06, noise:'rifle', auto:true, hs:0.10 },
};

/* ── Véhicules ───────────────────────────────────────
   Ils ne circulent que sur la voirie OSM. `len` sert au rendu et à
   l'écrasement des zombies, `seats` inclut le conducteur. */
export const VEHICLE = {
  car:    { name:'Voiture',  seats:4,  speed:15, accel:5.5, brake:11, turn:2.2, half:2.1, wide:0.9, hp:200, faction:'civ', color:'#c9d4e0' },
  van:    { name:'Fourgon',  seats:9,  speed:13, accel:4.0, brake:9,  turn:1.7, half:2.7, wide:1.1, hp:300, faction:'mil', color:'#5c6b4a' },
  truck:  { name:'Camion',   seats:18, speed:11, accel:3.0, brake:8,  turn:1.3, half:3.7, wide:1.3, hp:480, faction:'mil', color:'#4a5540' },
  supply: { name:'Ravitaillement', seats:4, speed:11, accel:3.0, brake:8, turn:1.3, half:3.7, wide:1.3, hp:420, faction:'mil', color:'#6b5a2f', ammo:9000 },
};

/* ── Escouades ───────────────────────────────────────
   Les combattants ne raisonnent plus en individus : une escouade porte
   l'ordre, ses membres tiennent une formation autour du chef. */
export const SQUAD = {
  milSize: 6,          // effectif visé d'une escouade militaire
  polSize: 3,          // …et d'une patrouille de gendarmerie
  spacing: 7,          // mètres entre deux équipiers en formation
  leash: 55,           // au-delà, un équipier rompt le contact et rejoint
  regroup: 26,         // distance à partir de laquelle on se resserre
  lowAmmo: 60,         // cartouches restantes déclenchant un ravitaillement
  escortRadius: 45,    // rayon de collecte des civils à escorter
};

/* ── Base, barrages, fortification ───────────────────── */
export const BASE = {
  radius: 70,
  resupplyRate: 220,   // cartouches par seconde et par soldat
  healRate: 6,         // points de vie par seconde
};
export const BLOCKADE = {
  buildTime: 20,       // secondes de mise en place
  halfWidth: 11,       // demi-largeur du barrage en travers de la route
  climbCost: 3.5,      // surcoût de franchissement à pied
};
export const FORTIFY = {
  rate: 0.055,         // niveau gagné par seconde et par occupant actif
  max: 3,
  breachPerLevel: 9,   // secondes d'effraction ajoutées par niveau
  windowRange: 34,     // portée de tir depuis une fenêtre
};

/* Carte de menace : grille grossière servant à juger si un secteur est sûr */
export const THREAT = { cell: 32, decay: 0.82, refresh: 1.0, radius: 1 };

/* ── Commandant ──────────────────────────────────────
   Tant qu'il est en vie, il coordonne les forces : il établit la base,
   déclenche les évacuations, ordonne barrages et frappes. S'il tombe, les
   escouades retombent sur leur seule initiative. */
export const COMMANDER = {
  hp: 150,
  think: 5,            // secondes entre deux décisions
  logMax: 60,          // lignes conservées dans le journal
  /* Dotations initiales et cadence de reconstitution (secondes) */
  assets: {
    heli:   { max: 2, reload: 200 },
    strike: { max: 3, reload: 260 },
    drop:   { max: 4, reload: 140 },
  },
  /* Seuils de doctrine */
  strikeMinZombies: 14,      // densité minimale pour justifier une frappe
  strikeSafeRadius: 70,      // aucun ami ni civil à moins de ça
  evacMinCivilians: 12,      // groupe justifiant un hélicoptère
  lowAmmoDrop: 90,           // cartouches/homme déclenchant un largage
  baseMaxThreat: 1.5,        // menace tolérée à l'emplacement de la base
};

/* Compétence de tir par type d'unité (0..1) */
export const SKILL = { [KIND.CIV]: 0.32, [KIND.POL]: 0.68, [KIND.MIL]: 0.88 };

/* ── États d'IA ──────────────────────────────────────── */
export const ST = {
  IDLE:0, WANDER:1, FLEE:2, SEEK:3, ATTACK:4, PATROL:5,
  INDOOR:6, BOARD:7, EVACUATED:8, DOWNED:9, TURNING:10,
  FEED:11, GOTO:12, DEAD:13, RESUPPLY:14,
  FORMUP:15,     // rejoint sa place dans la formation
  ESCORT:16,     // encadre un groupe de civils
  BUILD:17,      // met en place un barrage
  GARRISON:18,   // tient la base
  DRIVING:19,    // au volant
  ABOARD:20,     // passager d'un véhicule
  BOARDVEH:21,   // rejoint un véhicule pour y monter
  FOLLOW:22,     // civil suivant une escorte
};

/* Ordres transmis à une escouade */
export const ORDER = {
  PATROL:'patrol', ESCORT:'escort', BLOCKADE:'blockade',
  GARRISON:'garrison', RESUPPLY:'resupply', SWEEP:'sweep',
};
