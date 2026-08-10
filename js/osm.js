/* ═══════════════════════════════════════════════════════
   osm.js — récupération du terrain réel via Overpass API
   Bâtiments, eau, routes, murs → grille de navigation.
   ═══════════════════════════════════════════════════════ */

import { CFG, T } from './config.js';
import { polygonArea, polygonCentroid } from './geo.js';

/* Miroirs Overpass, du plus fiable au moins fiable.
   Ne pas ajouter d'instance à couverture régionale (overpass.osm.ch par
   exemple) : elles répondent « 200 OK » avec zéro élément hors de leur
   territoire, ce qui produirait silencieusement une carte vide. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/* Bâtiments qui n'hébergent personne */
const NON_RESIDENTIAL = new Set([
  'garage', 'garages', 'shed', 'roof', 'carport', 'greenhouse', 'hut',
  'bunker', 'ruins', 'silo', 'storage_tank', 'water_tower', 'transformer_tower',
  'service', 'container', 'cabin', 'construction',
]);
/* Multiplicateurs d'occupation selon l'usage */
const OCCUPANCY = {
  house: 1, detached: 1, semidetached_house: 1, terrace: 1.05,
  residential: 1.15, apartments: 1.35, dormitory: 1.5, hotel: 1.1,
  school: 0.55, university: 0.55, hospital: 0.7, retail: 0.45,
  commercial: 0.4, office: 0.5, industrial: 0.2, warehouse: 0.1,
  church: 0.15, chapel: 0.1, farm: 0.5, farm_auxiliary: 0.05,
  yes: 0.55,        // bâtiment non typé : mixte habitat / commerce
};

/* Nature du sol → drapeau de pénibilité. Les surfaces sont rasterisées avant
   la voirie et les bâtiments, qui priment ensuite. */
const GROUND_TAGS = {
  landuse: {
    forest: T.FOREST,
    farmland: T.FIELD, meadow: T.FIELD, orchard: T.FIELD, vineyard: T.FIELD,
    grass: T.FIELD, allotments: T.FIELD, greenfield: T.FIELD,
    village_green: T.FIELD, recreation_ground: T.FIELD, farmyard: T.FIELD,
  },
  natural: {
    wood: T.FOREST, scrub: T.FOREST,
    heath: T.ROUGH, sand: T.ROUGH, bare_rock: T.ROUGH,
    scree: T.ROUGH, shingle: T.ROUGH, fell: T.ROUGH,
    grassland: T.FIELD,
    wetland: T.MARSH,
  },
  leisure: {
    park: T.FIELD, garden: T.FIELD, golf_course: T.FIELD, pitch: T.FIELD,
  },
};

/** Drapeau de sol d'un élément OSM, ou 0 si ce n'est pas une surface de sol. */
function groundFlag(tags) {
  for (const key of ['landuse', 'natural', 'leisure']) {
    const v = tags[key];
    if (v && GROUND_TAGS[key][v] !== undefined) return GROUND_TAGS[key][v];
  }
  return 0;
}

function bboxQuery(b) {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:90];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["natural"="water"](${bb});
  relation["natural"="water"]["type"="multipolygon"](${bb});
  way["landuse"~"^(reservoir|basin)$"](${bb});
  way["waterway"="riverbank"](${bb});
  way["waterway"~"^(river|stream|canal|ditch|drain)$"](${bb});
  way["highway"](${bb});
  way["barrier"~"^(wall|fence|hedge|city_wall|retaining_wall)$"](${bb});
  way["landuse"~"^(forest|farmland|meadow|orchard|vineyard|grass|allotments|greenfield|village_green|recreation_ground|farmyard)$"](${bb});
  relation["landuse"~"^(forest|farmland|meadow|orchard|vineyard|grass)$"]["type"="multipolygon"](${bb});
  way["natural"~"^(wood|scrub|heath|grassland|sand|bare_rock|scree|shingle|wetland|fell)$"](${bb});
  relation["natural"~"^(wood|scrub|heath|grassland|wetland)$"]["type"="multipolygon"](${bb});
  way["leisure"~"^(park|garden|golf_course|pitch)$"](${bb});
);
out geom;`;
}

/* Un miroir Overpass saturé accepte la connexion puis ne répond jamais : sans
   échéance explicite, le chargement reste bloqué indéfiniment. */
const TIMEOUT_MS = 45000;

/** Récupère les données OSM avec bascule automatique de miroir. */
export async function fetchOSM(bounds, onProgress = () => {}) {
  const body = 'data=' + encodeURIComponent(bboxQuery(bounds));
  let lastErr;

  for (let i = 0; i < ENDPOINTS.length; i++) {
    const host = new URL(ENDPOINTS[i]).host;
    const ctrl = new AbortController();
    const started = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      onProgress(`Interrogation de ${host} — ${s} s (miroir ${i + 1}/${ENDPOINTS.length})…`);
    }, 1000);
    const killer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      onProgress(`Interrogation de ${host} (miroir ${i + 1}/${ENDPOINTS.length})…`);
      const res = await fetch(ENDPOINTS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onProgress(`Réception des données depuis ${host}…`);
      const json = await res.json();
      if (!json.elements) throw new Error('réponse illisible');
      /* Zéro élément peut être légitime (rase campagne) ou signaler un miroir
         défaillant : on tente les suivants, et on accepte le vide seulement si
         tous sont d'accord. */
      if (json.elements.length === 0 && i < ENDPOINTS.length - 1) {
        lastErr = new Error(`${host} a renvoyé une zone vide`);
        continue;
      }
      return json;
    } catch (e) {
      lastErr = e.name === 'AbortError'
        ? new Error(`${host} n'a pas répondu en ${TIMEOUT_MS / 1000} s`)
        : e;
    } finally {
      clearInterval(tick);
      clearTimeout(killer);
    }
  }
  throw new Error(`Overpass injoignable — ${lastErr?.message || 'raison inconnue'}. Réessaie dans un instant.`);
}

/** Convertit la géométrie OSM (lat/lon) en points monde (m). */
function toWorld(frame, geom) {
  const pts = new Array(geom.length);
  for (let i = 0; i < geom.length; i++) pts[i] = frame.toWorld(geom[i].lat, geom[i].lon);
  return pts;
}

function isClosed(geom) {
  if (geom.length < 4) return false;
  const a = geom[0], b = geom[geom.length - 1];
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

/**
 * Rasterise les éléments OSM dans la grille.
 * @returns {{buildings:Array, stats:Object}}
 */
export function buildTerrain(osm, frame, grid) {
  const buildings = [];
  let nWater = 0, nRoad = 0, nBarrier = 0, nGround = 0;

  const doPolygon = (pts, tags) => {
    if (pts.length < 3) return;
    if (tags.building) {
      const area = polygonArea(pts);
      if (area < CFG.POP.MIN_FOOTPRINT) { grid.fillPolygon(pts, T.BUILDING); return; }
      grid.fillPolygon(pts, T.BUILDING);
      const type = tags.building;
      const levels = clampLevels(tags['building:levels']);
      const c = polygonCentroid(pts);
      /* Overpass renvoie aussi les bâtiments qui débordent de la zone : on les
         garde comme obstacles (leur emprise compte pour les collisions et la
         vue) mais on ne les peuple pas — leurs habitants apparaîtraient hors
         du terrain de jeu. */
      const outside = !frame.contains(c.x, c.y);
      const occ = (outside || NON_RESIDENTIAL.has(type)) ? 0 : (OCCUPANCY[type] ?? 0.7);
      buildings.push({ area, levels, occ, type, c, pts, outside, capacity: 0, occupants: [] });
    } else if (tags.natural === 'water' || tags.waterway === 'riverbank' ||
               tags.landuse === 'reservoir' || tags.landuse === 'basin') {
      grid.fillPolygon(pts, T.WATER); nWater++;
    }
  };

  for (const el of osm.elements) {
    const tags = el.tags || {};
    let geoms = [];

    if (el.type === 'way' && el.geometry) geoms = [el.geometry];
    else if (el.type === 'relation' && el.members) {
      geoms = el.members.filter(m => m.role !== 'inner' && m.geometry).map(m => m.geometry);
    }
    if (!geoms.length) continue;

    for (const g of geoms) {
      if (g.length < 2) continue;
      const pts = toWorld(frame, g);

      /* Surfaces */
      if (tags.building || tags.natural === 'water' || tags.waterway === 'riverbank' ||
          tags.landuse === 'reservoir' || tags.landuse === 'basin') {
        if (isClosed(g) || el.type === 'relation') { doPolygon(pts, tags); continue; }
      }

      /* Natures de sol (bois, champs, caillasse, marais).
         L'ordre de tracé importe peu : la table de pénibilité arbitre les
         superpositions, la voirie et le bâti primant toujours sur le sol. */
      const ground = groundFlag(tags);
      if (ground) {
        if (isClosed(g) || el.type === 'relation') { grid.fillPolygon(pts, ground); nGround++; }
        continue;
      }

      /* Cours d'eau linéaires */
      if (tags.waterway && CFG.WIDTH[tags.waterway] !== undefined) {
        const w = parseFloat(tags.width) || CFG.WIDTH[tags.waterway];
        grid.strokeLine(pts, w, T.WATER); nWater++;
        continue;
      }

      /* Routes */
      if (tags.highway) {
        const w = CFG.WIDTH[tags.highway] ?? 6;
        const lanes = parseFloat(tags.lanes);
        grid.strokeLine(pts, lanes ? Math.max(w, lanes * 3.2) : w, T.ROAD);
        nRoad++;
        continue;
      }

      /* Barrières */
      if (tags.barrier) {
        const b = tags.barrier;
        const w = CFG.WIDTH[b] ?? 0.6;
        const solid = (b === 'wall' || b === 'city_wall' || b === 'retaining_wall');
        grid.strokeLine(pts, w, solid ? T.WALL : T.FENCE);
        nBarrier++;
        continue;
      }
    }
  }

  /* Les routes ne doivent jamais “percer” un bâtiment : le drapeau
     ROAD est cumulatif, BLOCK_MOVE gagne toujours — rien à faire. */

  return {
    buildings,
    stats: { buildings: buildings.length, water: nWater, roads: nRoad,
             barriers: nBarrier, ground: nGround },
  };
}

function clampLevels(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(40, n);
}

/** Estime la population civile d'un ensemble de bâtiments. */
export function estimatePopulation(buildings, frame, densityMul = 1) {
  let total = 0;
  for (const b of buildings) {
    if (b.occ <= 0) { b.capacity = 0; continue; }
    // Étages : donnée OSM sinon heuristique sur l'emprise au sol
    const lv = b.levels ?? (b.area < 130 ? 1 : b.area < 400 ? 2 : 3);
    const floor = b.area * lv;
    let n = Math.round((floor / CFG.POP.M2_PER_PERSON) * b.occ * densityMul);
    n = Math.min(n, CFG.POP.MAX_PER_BUILDING);
    if (b.occ >= 0.6 && b.area >= 40 && n === 0 && densityMul > 0) n = Math.random() < 0.6 ? 1 : 0;
    b.capacity = n;
    total += n;
  }
  // Campagne : population diffuse minimale
  if (total < 4 && densityMul > 0) {
    total += Math.round(frame.areaKm2 * CFG.POP.EMPTY_ZONE_DENSITY * densityMul);
  }
  return total;
}
