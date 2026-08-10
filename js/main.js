/* ═══════════════════════════════════════════════════════
   main.js — carte, interface, boucle principale
   ═══════════════════════════════════════════════════════ */

import { CFG, KIND, ST, STAMINA } from './config.js';
import { Frame, clamp } from './geo.js';
import { Grid } from './grid.js';
import { fetchOSM, buildTerrain, estimatePopulation } from './osm.js';
import { loadRelief } from './elevation.js';
import { Sim } from './sim.js';
import { Renderer } from './render.js';
import { commanderAlive } from './commander.js';
import { PROVIDERS, requestOrders } from './ai-command.js';

/* ── Raccourcis DOM ─────────────────────────────────── */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ═══ Carte ═══════════════════════════════════════════ */
const map = L.map('map', {
  zoomControl: true,
  center: [48.8566, 2.3522],
  zoom: 15,
  minZoom: 3,
  maxZoom: 20,
  preferCanvas: true,
});
L.control.zoom({ position: 'bottomright' });

const sat = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics' }
).addTo(map);

/* Libellés (rues, lieux-dits) : calque de référence Esri, même fournisseur que
   l'imagerie et sans clé d'API. */
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, maxNativeZoom: 19, opacity: 0.9, attribution: '' }
).addTo(map);

/* ═══ État global ═════════════════════════════════════ */
const sim = new Sim();
const renderer = new Renderer($('#fx'), map, sim);
let zoneRect = null;        // L.Rectangle
let zoneBounds = null;      // L.LatLngBounds
let terrainLoaded = false;
let tool = 'none';
let popEstimate = 0;

/* ═══ Toast ═══════════════════════════════════════════ */
let toastT;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'on ' + kind;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.className = kind, 3600);
}

/* ═══ Dessin de la zone ═══════════════════════════════ */
let drawing = false, dragStart = null, tmpRect = null;

function setDrawMode(on) {
  drawing = on;
  document.body.classList.toggle('drawing', on);
  $('#btn-draw').classList.toggle('on', on);
  $('#btn-draw').textContent = on ? '✏️ Clique-glisse sur la carte' : '✏️ Dessiner la zone';
  if (on) { setTool('none'); map.dragging.disable(); }
  else map.dragging.enable();
}

map.on('mousedown', ev => {
  if (drawing) { dragStart = ev.latlng; return; }
  if (tool === 'patrol' && terrainLoaded) { dragStart = ev.latlng; map.dragging.disable(); }
});

map.on('mousemove', ev => {
  if (!dragStart) return;
  const b = L.latLngBounds(dragStart, ev.latlng);
  if (!tmpRect) {
    tmpRect = L.rectangle(b, {
      color: drawing ? '#4ea1ff' : '#7ee787', weight: 2, fillOpacity: 0.08, dashArray: '6 5',
    }).addTo(map);
  } else tmpRect.setBounds(b);
});

map.on('mouseup', ev => {
  if (!dragStart) return;
  const b = L.latLngBounds(dragStart, ev.latlng);
  const wasDrawing = drawing;
  dragStart = null;
  if (tmpRect) { map.removeLayer(tmpRect); tmpRect = null; }

  if (wasDrawing) {
    setDrawMode(false);
    if (b.getNorth() - b.getSouth() < 1e-5) { toast('Zone trop petite — clique puis glisse.', 'warn'); return; }
    setZone(b);
  } else if (tool === 'patrol') {
    map.dragging.enable();
    if (!sim.ready) return;
    const sw = sim.frame.toWorld(b.getSouth(), b.getWest());
    const ne = sim.frame.toWorld(b.getNorth(), b.getEast());
    const rect = {
      x0: Math.min(sw.x, ne.x), x1: Math.max(sw.x, ne.x),
      y0: Math.min(sw.y, ne.y), y1: Math.max(sw.y, ne.y),
    };
    if (rect.x1 - rect.x0 < 6 || rect.y1 - rect.y0 < 6) {
      toast('Trace un rectangle plus large pour la patrouille.', 'warn'); return;
    }
    const n = sim.assignPatrol(rect, [KIND.MIL, KIND.POL], 24);
    drawPatrolBox(b);
    toast(n ? `${n} unité(s) affectée(s) à la patrouille.` : 'Aucune unité disponible.', n ? '' : 'warn');
  }
});

const patrolBoxes = L.layerGroup().addTo(map);
let baseMarker = null;
function drawBaseMarker(latlng) {
  if (baseMarker) map.removeLayer(baseMarker);
  baseMarker = L.circle(latlng, {
    radius: sim.base ? sim.base.r : 70,
    color: '#7ee787', weight: 1, fillOpacity: 0.03, interactive: false,
  }).addTo(map);
}
function drawPatrolBox(b) {
  const r = L.rectangle(b, { color: '#7ee787', weight: 1.5, fillOpacity: 0.05, dashArray: '4 6', interactive: false });
  patrolBoxes.addLayer(r);
}

function setZone(bounds) {
  const f = new Frame({
    south: bounds.getSouth(), west: bounds.getWest(),
    north: bounds.getNorth(), east: bounds.getEast(),
  });
  if (f.width > CFG.MAX_ZONE_M || f.height > CFG.MAX_ZONE_M) {
    toast(`Zone trop grande (${Math.round(f.width)}×${Math.round(f.height)} m). Maximum ${CFG.MAX_ZONE_M} m de côté.`, 'err');
    return;
  }
  if (zoneRect) map.removeLayer(zoneRect);
  zoneBounds = bounds;
  zoneRect = L.rectangle(bounds, {
    color: '#4ea1ff', weight: 2, fill: false, dashArray: '8 6', interactive: false,
  }).addTo(map);
  terrainLoaded = false;
  sim.ready = false;
  $('#btn-load').disabled = false;
  $('#zone-info').innerHTML =
    `Zone <b>${Math.round(f.width)} × ${Math.round(f.height)} m</b> — <b>${f.areaKm2.toFixed(2)} km²</b><br>` +
    `Grille <b>${Math.ceil(f.width / CFG.CELL)} × ${Math.ceil(f.height / CFG.CELL)}</b> cellules de ${CFG.CELL} m`;
  $('#pop-estimate').textContent = 'Charge le terrain pour estimer la population';
  toast('Zone définie. Charge maintenant le terrain OSM.');
}

/* ═══ Chargement du terrain ═══════════════════════════ */
async function loadTerrain() {
  if (!zoneBounds) return;
  const btn = $('#btn-load'), st = $('#load-status');
  btn.disabled = true;
  st.className = 'status'; st.textContent = 'Préparation…';

  const frame = new Frame({
    south: zoneBounds.getSouth(), west: zoneBounds.getWest(),
    north: zoneBounds.getNorth(), east: zoneBounds.getEast(),
  });
  const grid = new Grid(frame, CFG.CELL);

  try {
    const osm = await fetchOSM(frame.b, msg => { st.textContent = msg; });
    st.textContent = 'Rasterisation du terrain…';
    await new Promise(r => setTimeout(r, 16));
    const { buildings, stats } = buildTerrain(osm, frame, grid);

    sim.setup(frame, grid, buildings);
    terrainLoaded = true;
    renderer.terrainVersion = -1;

    /* Relief : facultatif et sans conséquence en cas d'échec — le terrain
       reste simplement plat. */
    let relief = null;
    if ($('#opt-relief').checked) {
      relief = await loadRelief(frame, grid, msg => { st.textContent = msg; });
      renderer.terrainVersion = -1;
    }

    popEstimate = estimatePopulation(buildings, frame, sim.params.density);
    st.className = 'status ok';
    const reliefTxt = !relief ? 'relief ignoré'
      : relief.ok ? `relief ${relief.minAlt}–${relief.maxAlt} m, pente moyenne ${relief.meanSlope} %`
      : `⚠ ${relief.reason}`;
    st.textContent = `✓ ${stats.buildings} bâtiments · ${stats.roads} tronçons · ` +
      `${stats.ground} surfaces de sol · ${stats.water} plans d'eau · ${reliefTxt}`;
    updatePopEstimate();
    map.fitBounds(zoneBounds, { padding: [40, 40] });
    startSim();
  } catch (err) {
    st.className = 'status err';
    st.textContent = '✗ ' + err.message;
    btn.disabled = false;
    toast('Échec du chargement OSM : ' + err.message, 'err');
  }
}

function updatePopEstimate() {
  if (!terrainLoaded) return;
  popEstimate = estimatePopulation(sim.buildings, sim.frame, sim.params.density);
  $('#pop-estimate').innerHTML =
    `Population estimée : <b>${popEstimate}</b> civils<br>` +
    `<span style="opacity:.7">≈ ${Math.round(popEstimate / Math.max(0.01, sim.frame.areaKm2))} hab/km²</span>`;
}

/* ═══ Démarrage / réinitialisation ════════════════════ */
function startSim() {
  sim.reset();
  patrolBoxes.clearLayers();
  if (baseMarker) { map.removeLayer(baseMarker); baseMarker = null; }
  /* reset() reconstruit l'état de commandement : on resynchronise l'interface */
  logSeen = -1;
  const aiBtn = $('#btn-ai-toggle');
  if (aiBtn) { aiBtn.textContent = '▶ Activer'; aiBtn.classList.remove('on'); }
  estimatePopulation(sim.buildings, sim.frame, sim.params.density);
  sim.populate();
  renderer.terrainVersion = -1;
  toast(`Simulation prête : ${sim.stats.civ} civils, ${sim.stats.pol} gendarmes, ${sim.stats.mil} militaires.`);
  setRunning(false);
}

function setRunning(on) {
  sim.running = on;
  const b = $('#btn-play');
  b.textContent = on ? '❚❚' : '▶';
  b.classList.toggle('playing', on);
}

/* ═══ Outils carte ════════════════════════════════════ */
function setTool(t) {
  tool = t;
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  document.body.classList.toggle('tool-active', t !== 'none');
  if (t === 'patrol') toast('Trace un rectangle : les escouades les plus proches y patrouilleront.');
  else if (t === 'heli') toast('Clique pour désigner une zone d\'atterrissage.');
  else if (t === 'strike') toast('Clique pour désigner un point d\'impact.');
  else if (t === 'drop') toast('Clique pour larguer armes et munitions.');
  else if (t === 'spawnz') toast('Clique pour lâcher un groupe de zombies.');
  else if (t === 'base') toast('Clique pour installer la base : les civils y seront conduits, les soldats y refont le plein.');
  else if (t === 'block') toast('Clique sur une route : une escouade ira monter le barrage.');
  else if (t === 'sweep') toast('Clique sur un secteur à nettoyer.');
}

map.on('click', ev => {
  if (drawing || !sim.ready || tool === 'none' || tool === 'patrol') return;
  const w = sim.frame.toWorld(ev.latlng.lat, ev.latlng.lng);
  if (!sim.frame.contains(w.x, w.y)) { toast('Point hors de la zone de jeu.', 'warn'); return; }

  switch (tool) {
    case 'base': {
      const b = sim.setBase(w.x, w.y);
      if (b) {
        drawBaseMarker(ev.latlng);
        toast(`Base établie : ravitaillement, soins et refuge dans un rayon de ${b.r} m.`);
      } else toast('Impossible d\'installer la base ici.', 'warn');
      break;
    }
    case 'block': {
      const bl = sim.orderBlockadeAt(w.x, w.y);
      if (bl) toast('Barrage ordonné — l\'escouade la plus proche part le monter.');
      else toast('Aucune route exploitable ici, ou aucune escouade disponible.', 'warn');
      break;
    }
    case 'sweep': {
      const sq = sim.orderSweep(w.x, w.y);
      if (sq) toast(`Ratissage ordonné à une escouade de ${sq.members.length} hommes.`);
      else toast('Aucune escouade disponible.', 'warn');
      break;
    }
    case 'heli': {
      const h = sim.callHeli(w.x, w.y);
      if (h) { toast(`Hélicoptère en approche — capacité ${h.capacity}.`); opsStatus(); }
      else toast('Pas de surface dégagée pour se poser ici.', 'warn');
      break;
    }
    case 'strike': {
      const s = sim.callStrike(w.x, w.y);
      toast(`Frappe demandée : impact dans ${s.t.toFixed(0)} s, rayon ${s.r} m.`, 'warn');
      opsStatus();
      break;
    }
    case 'drop': {
      sim.callDrop(w.x, w.y);
      toast('Largage en cours — la caisse touchera le sol dans 6 s.');
      opsStatus();
      break;
    }
    case 'spawnz': {
      const n = sim.spawnZombiesAt(w.x, w.y, 12, 20);
      toast(`${n} zombies lâchés.`, 'warn');
      break;
    }
  }
});

function opsStatus() {
  const parts = [];
  if (sim.helis.length) parts.push(`${sim.helis.length} hélico(s)`);
  if (sim.strikes.length) parts.push(`${sim.strikes.length} frappe(s) en attente`);
  const crates = sim.crates.filter(c => c.uses > 0).length;
  if (crates) parts.push(`${crates} caisse(s)`);
  const built = sim.blockades.filter(b => b.built).length;
  if (sim.blockades.length) parts.push(`${built}/${sim.blockades.length} barrage(s)`);
  if (sim.base) parts.push('base établie');
  $('#ops-status').textContent = parts.length ? parts.join(' · ') : 'Aucune opération en cours';
}

/** Résumé de l'état des escouades (effectif, mission, munitions). */
function squadStatus() {
  const el = $('#squad-info');
  if (!sim.squads.length) { el.textContent = 'Aucune escouade'; return; }
  const label = {
    patrol: 'patrouille', escort: 'escorte', blockade: 'barrage',
    garrison: 'base', resupply: 'ravitaillement', sweep: 'ratissage',
  };
  const byMission = {};
  let men = 0, civs = 0, ammo = 0;
  for (const sq of sim.squads) {
    const m = sq.order ? (label[sq.order.type] || sq.order.type) : 'initiative';
    byMission[m] = (byMission[m] || 0) + 1;
    men += sq.members.length;
    civs += sq.escorted.filter(c => c.alive).length;
    for (const s of sq.members) ammo += s.mag + s.reserve;
  }
  const veh = sim.vehicles.filter(v => v.alive).length;
  const rolling = sim.vehicles.filter(v => v.alive && v.v > 1).length;
  el.innerHTML =
    `<b>${sim.squads.length}</b> escouades · <b>${men}</b> hommes · <b>${civs}</b> civils encadrés<br>` +
    Object.entries(byMission).map(([k, v]) => `${v}× ${k}`).join(' · ') + '<br>' +
    `<span style="opacity:.7">${Math.round(ammo / Math.max(1, men))} cartouches/homme · ` +
    `${veh} véhicules dont ${rolling} en mouvement</span>`;
}

/* ═══ Interface : liaisons ════════════════════════════ */
function bindSlider(id, label, key, fmt = v => v, onChange = null) {
  const el = $(id), lb = $(label);
  const apply = () => {
    const v = parseFloat(el.value);
    sim.params[key] = v;
    lb.textContent = fmt(v);
    if (onChange) onChange(v);
  };
  el.addEventListener('input', apply);
  apply();
}

bindSlider('#s-density', '#v-density', 'density', v => v.toFixed(1), updatePopEstimate);
bindSlider('#s-outdoor', '#v-outdoor', 'outdoorPct');
bindSlider('#s-police', '#v-police', 'police');
bindSlider('#s-military', '#v-military', 'military');
bindSlider('#s-armedciv', '#v-armedciv', 'armedCivPct');
bindSlider('#s-zcount', '#v-zcount', 'zCount');
bindSlider('#s-zfast', '#v-zfast', 'zFastPct');
bindSlider('#s-zslow', '#v-zslow', 'zSlow', v => v.toFixed(1));
bindSlider('#s-zfastspd', '#v-zfastspd', 'zFast', v => v.toFixed(1));
bindSlider('#s-infect', '#v-infect', 'infectChance');
bindSlider('#s-turn', '#v-turn', 'turnDelay');
bindSlider('#s-zsight', '#v-zsight', 'zSight');
bindSlider('#s-zhear', '#v-zhear', 'zHear');
bindSlider('#s-cars', '#v-cars', 'civCars');
bindSlider('#s-trucks', '#v-trucks', 'milTrucks');
bindSlider('#s-hcap', '#v-hcap', 'heliCap');
bindSlider('#s-hboard', '#v-hboard', 'heliBoard', v => v.toFixed(1));
bindSlider('#s-hwait', '#v-hwait', 'heliWait');
bindSlider('#s-srad', '#v-srad', 'strikeRadius');

$('#s-sprite').addEventListener('input', e => {
  renderer.opts.spriteScale = parseFloat(e.target.value);
  $('#v-sprite').textContent = parseFloat(e.target.value).toFixed(1);
});

/* Endurance : le curseur agit sur la réserve, pas sur la consommation —
   ×2 signifie « deux fois plus de souffle », ce qui se lit directement. */
const BASE_DRAIN = STAMINA.drainRun, BASE_REC = STAMINA.recover;
$('#s-stam').addEventListener('input', e => {
  const k = parseFloat(e.target.value);
  STAMINA.drainRun = BASE_DRAIN / k;
  STAMINA.recover = BASE_REC * Math.sqrt(k);
  $('#v-stam').textContent = k.toFixed(1);
});

/* Cases à cocher d'affichage */
const checks = [
  ['#opt-show-terrain', 'terrain'], ['#opt-los', 'los'],
  ['#opt-paths', 'paths'], ['#opt-names', 'bars'], ['#opt-blood', 'blood'],
  ['#opt-squads', 'squads'],
];
for (const [sel, key] of checks) {
  const el = $(sel);
  renderer.opts[key] = el.checked;
  el.addEventListener('change', () => renderer.opts[key] = el.checked);
}

/* ═══ Commandement ════════════════════════════════════ */
$('#opt-commander').addEventListener('change', e => sim.params.commander = e.target.checked);

/* Réglages du LLM. La clé vit dans le navigateur et nulle part ailleurs. */
const aiCfg = {
  provider: localStorage.getItem('zs.ai.provider') || 'gemini',
  model: localStorage.getItem('zs.ai.model') || '',
  key: localStorage.getItem('zs.ai.key') || '',
  period: parseFloat(localStorage.getItem('zs.ai.period')) || 30,
};

function fillModels() {
  const p = PROVIDERS[aiCfg.provider];
  const sel = $('#ai-model');
  sel.innerHTML = '';
  for (const m of p.models) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  }
  if (!p.models.includes(aiCfg.model)) aiCfg.model = p.models[0];
  sel.value = aiCfg.model;
  $('#ai-keyhint').textContent = p.keyHint;
}
$('#ai-provider').value = aiCfg.provider;
$('#ai-key').value = aiCfg.key;
$('#s-aiperiod').value = aiCfg.period;
$('#v-aiperiod').textContent = aiCfg.period;
fillModels();

const saveAI = () => {
  localStorage.setItem('zs.ai.provider', aiCfg.provider);
  localStorage.setItem('zs.ai.model', aiCfg.model);
  localStorage.setItem('zs.ai.key', aiCfg.key);
  localStorage.setItem('zs.ai.period', aiCfg.period);
};
$('#ai-provider').addEventListener('change', e => { aiCfg.provider = e.target.value; fillModels(); saveAI(); });
$('#ai-model').addEventListener('change', e => { aiCfg.model = e.target.value; saveAI(); });
$('#ai-key').addEventListener('change', e => { aiCfg.key = e.target.value.trim(); saveAI(); });
$('#s-aiperiod').addEventListener('input', e => {
  aiCfg.period = parseFloat(e.target.value);
  $('#v-aiperiod').textContent = aiCfg.period;
  saveAI();
});

/* Le moteur ne connaît pas le réseau : il appelle ce crochet, on branche le LLM. */
sim.requestAIOrders = () => requestOrders(sim, aiCfg);

$('#btn-ai-toggle').addEventListener('click', () => {
  if (!sim.ready) { toast('Charge d\'abord une zone.', 'warn'); return; }
  const ai = sim.command.ai;
  if (!ai.enabled && !aiCfg.key) { toast('Renseigne une clé d\'API d\'abord.', 'warn'); return; }
  ai.enabled = !ai.enabled;
  ai.nextT = 0;
  const b = $('#btn-ai-toggle');
  b.textContent = ai.enabled ? '⏸ Reprendre la doctrine locale' : '▶ Activer';
  b.classList.toggle('on', ai.enabled);
  toast(ai.enabled
    ? `Commandement confié à ${PROVIDERS[aiCfg.provider].label}.`
    : 'Retour à la doctrine locale.');
});
$('#btn-ai-once').addEventListener('click', () => {
  if (!sim.ready) { toast('Charge d\'abord une zone.', 'warn'); return; }
  if (!aiCfg.key) { toast('Renseigne une clé d\'API d\'abord.', 'warn'); return; }
  if (!commanderAlive(sim)) { toast('Aucun commandant en vie pour transmettre.', 'warn'); return; }
  requestOrders(sim, aiCfg);
  toast('Situation transmise à l\'état-major…');
});

/** Journal et état du commandement. */
let logSeen = -1;
function commandStatus() {
  const C = sim.command;
  if (!C) return;
  const el = $('#cmd-status');
  if (commanderAlive(sim)) {
    const a = C.assets;
    el.innerHTML = `Commandant <b>en poste</b> · ${sim.squads.length} escouades<br>` +
      `<span style="opacity:.75">🚁 ${a.heli.ready} · 💥 ${a.strike.ready} · 📦 ${a.drop.ready} disponibles</span>`;
  } else {
    el.innerHTML = C.officer
      ? '<b style="color:#ff5b5b">Commandant hors de combat</b><br><span style="opacity:.75">Les escouades agissent à leur seule initiative.</span>'
      : 'Aucun commandant';
  }

  if (C.log.length !== logSeen) {
    logSeen = C.log.length;
    const box = $('#cmd-log');
    box.innerHTML = '';
    /* Rendu inversé (le plus récent en haut) via flex column-reverse. */
    for (const L of C.log.slice(-30)) {
      const d = document.createElement('div');
      d.className = L.kind;
      const t = document.createElement('span');
      t.className = 't';
      const s = L.t | 0;
      t.textContent = `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      d.appendChild(t);
      d.appendChild(document.createTextNode(L.text));
      box.appendChild(d);
    }
  }

  const st = $('#ai-status');
  if (C.ai.busy) { st.className = 'status'; st.textContent = 'Transmission en cours…'; }
  else if (C.ai.lastError) { st.className = 'status err'; st.textContent = '✗ ' + C.ai.lastError; }
  else if (C.ai.calls) { st.className = 'status ok'; st.textContent = `✓ ${C.ai.calls} consultation(s)`; }
  else st.textContent = '';
}

/* Véhicules et escorte */
$('#opt-vehicles').addEventListener('change', e => sim.params.useVehicles = e.target.checked);
$('#opt-escort').addEventListener('change', e => sim.params.autoEscort = e.target.checked);

/* Ordres généraux */
$('#btn-garrison').addEventListener('click', () => {
  if (!sim.base) { toast('Installe d\'abord une base (outil 🏕️).', 'warn'); return; }
  let n = 0;
  for (const sq of sim.squads) { sq.order = { type: 'garrison' }; sq.prevOrder = null; n++; }
  toast(`${n} escouade(s) rappelée(s) à la base.`);
});
$('#btn-free').addEventListener('click', () => {
  for (const sq of sim.squads) { sq.order = null; sq.prevOrder = null; }
  patrolBoxes.clearLayers();
  toast('Escouades rendues à leur initiative : regroupement et mise à l\'abri des civils.');
});

/* Azimuts */
$$('.az[data-az]').forEach(b => {
  if (sim.params.azimuths.has(b.dataset.az)) b.classList.add('on');
  b.addEventListener('click', () => {
    const a = b.dataset.az;
    if (sim.params.azimuths.has(a)) sim.params.azimuths.delete(a);
    else sim.params.azimuths.add(a);
    b.classList.toggle('on', sim.params.azimuths.has(a));
  });
});

/* Vagues */
$('#btn-wave').addEventListener('click', () => {
  if (!sim.ready) { toast('Définis et charge d\'abord une zone.', 'warn'); return; }
  if (!sim.params.azimuths.size) { toast('Choisis au moins un azimut d\'arrivée.', 'warn'); return; }
  const n = sim.spawnWave();
  toast(`Vague lancée : ${n} zombies depuis ${[...sim.params.azimuths].join(', ')}.`, 'warn');
  if (!sim.running) setRunning(true);
});
$('#opt-autowave').addEventListener('change', e => sim.params.autoWave = e.target.checked);
$('#n-waveperiod').addEventListener('change', e => {
  sim.params.wavePeriod = clamp(parseFloat(e.target.value) || 120, 10, 3600);
});

/* Boutons principaux */
$('#btn-draw').addEventListener('click', () => setDrawMode(!drawing));
$('#btn-clear-zone').addEventListener('click', () => {
  if (zoneRect) map.removeLayer(zoneRect);
  zoneRect = null; zoneBounds = null; terrainLoaded = false;
  sim.ready = false; setRunning(false);
  patrolBoxes.clearLayers();
  $('#btn-load').disabled = true;
  $('#zone-info').textContent = 'Aucune zone définie';
  $('#load-status').textContent = '';
});
$('#btn-load').addEventListener('click', loadTerrain);
$('#btn-reset').addEventListener('click', () => {
  if (!terrainLoaded) { toast('Rien à réinitialiser.', 'warn'); return; }
  startSim(); opsStatus();
});
$('#btn-play').addEventListener('click', () => {
  if (!sim.ready) { toast('Définis une zone et charge le terrain.', 'warn'); return; }
  setRunning(!sim.running);
});
$$('.tbtn.spd').forEach(b => b.addEventListener('click', () => {
  sim.speed = parseFloat(b.dataset.speed);
  $$('.tbtn.spd').forEach(o => o.classList.toggle('on', o === b));
}));
$('.tbtn.spd').classList.add('on');
$('#btn-panel').addEventListener('click', () => $('#panel').classList.toggle('hidden'));

/** Recadre la vue sur le terrain de jeu. */
function fitZone() {
  if (!zoneBounds) { toast('Aucune zone définie.', 'warn'); return; }
  map.fitBounds(zoneBounds, { padding: [40, 40] });
}
$('#btn-fit').addEventListener('click', fitZone);
$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('.card > h2').forEach(h => h.addEventListener('click', () => {
  const c = h.parentElement;
  c.dataset.open = c.dataset.open === '1' ? '0' : '1';
}));

/* Raccourcis clavier */
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); }
  else if (e.code === 'Tab') { e.preventDefault(); $('#panel').classList.toggle('hidden'); }
  else if (e.key === '1') setTool('heli');
  else if (e.key === '2') setTool('strike');
  else if (e.key === '3') setTool('drop');
  else if (e.key === '4') setTool('patrol');
  else if (e.key === '5') setTool('spawnz');
  else if (e.key === '6') setTool('base');
  else if (e.key === '7') setTool('block');
  else if (e.key === '8') setTool('sweep');
  else if (e.key === 'f' || e.key === 'F') fitZone();
  else if (e.key === 'Escape') { setTool('none'); if (drawing) setDrawMode(false); }
});

/* ═══ Recherche de lieu (Nominatim) ═══════════════════ */
let searchT;
$('#search').addEventListener('input', e => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  const box = $('#search-results');
  if (q.length < 3) { box.className = ''; box.innerHTML = ''; return; }
  searchT = setTimeout(async () => {
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q));
      const list = await r.json();
      box.innerHTML = '';
      for (const it of list) {
        const d = document.createElement('div');
        d.textContent = it.display_name;
        d.addEventListener('click', () => {
          map.setView([parseFloat(it.lat), parseFloat(it.lon)], 16);
          box.className = ''; $('#search').value = '';
        });
        box.appendChild(d);
      }
      box.className = list.length ? 'on' : '';
    } catch { /* réseau indisponible : on ignore */ }
  }, 450);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#search-wrap')) $('#search-results').className = '';
});

/* ═══ Boucle principale ═══════════════════════════════ */
let last = performance.now(), acc = 0, fpsT = 0, frames = 0;

function frame(now) {
  const real = Math.min(0.25, (now - last) / 1000);
  last = now;

  if (sim.ready && sim.running) {
    acc += real * sim.speed;
    let steps = 0;
    while (acc >= CFG.TICK && steps < CFG.MAX_STEPS_PER_FRAME) {
      sim.step(CFG.TICK);
      acc -= CFG.TICK;
      steps++;
    }
    if (acc > CFG.TICK * CFG.MAX_STEPS_PER_FRAME) acc = 0;   // on lâche le retard
  }

  renderer.draw();

  /* HUD */
  frames++;
  if (now - fpsT > 400) {
    const fps = Math.round(frames * 1000 / (now - fpsT));
    fpsT = now; frames = 0;
    $('#hud-fps').textContent = fps + ' fps';
    $('#hud-civ').textContent = sim.stats.civ;
    $('#hud-pol').textContent = sim.stats.pol;
    $('#hud-mil').textContent = sim.stats.mil;
    $('#hud-zom').textContent = sim.stats.zom;
    $('#hud-evac').textContent = sim.stats.evac;
    $('#hud-shelter').textContent = sim.stats.sheltered || 0;
    $('#hud-dead').textContent = sim.stats.dead;
    const t = sim.time | 0;
    $('#hud-time').textContent =
      String((t / 60) | 0).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
    opsStatus();
    squadStatus();
    commandStatus();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ═══ Démarrage ═══════════════════════════════════════ */
toast('Bienvenue. Cherche un lieu, puis clique « Dessiner la zone ».');
/* Accès console pour inspecter ou bidouiller la partie en cours */
/* `window.map` est déjà pris par la div #map (accès nommé du DOM) → gameMap */
Object.assign(window, { sim, gameMap: map, renderer, setZone, loadTerrain, startSim, toast });
