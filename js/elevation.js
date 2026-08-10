/* ═══════════════════════════════════════════════════════
   elevation.js — relief du terrain
   OpenStreetMap ne porte pas d'altitude : on va la chercher dans les
   tuiles « Terrarium » du jeu de données ouvert AWS Terrain Tiles
   (libres, sans clé, CORS autorisé). Chaque pixel encode une altitude
   en mètres sur trois octets ; on en déduit la pente de chaque cellule
   de la grille de navigation.

   Tout échec est sans conséquence : la simulation tourne à plat.
   ═══════════════════════════════════════════════════════ */

const TILE = 256;
const ENDPOINTS = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
  'https://elevation-tiles-prod.s3.amazonaws.com/terrarium',
];

/* Web Mercator : lat/lon → coordonnée de tuile fractionnaire */
const lon2tx = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2ty = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
};

/** Zoom donnant une résolution utile sans dépasser ~24 tuiles. */
function pickZoom(bounds) {
  for (let z = 15; z >= 11; z--) {
    const x0 = Math.floor(lon2tx(bounds.west, z)), x1 = Math.floor(lon2tx(bounds.east, z));
    const y0 = Math.floor(lat2ty(bounds.north, z)), y1 = Math.floor(lat2ty(bounds.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 24) return z;
  }
  return 11;
}

function loadTile(z, x, y) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOne = () => {
      const img = new Image();
      img.crossOrigin = 'anonymous';   // indispensable pour relire les pixels
      img.onload = () => resolve(img);
      img.onerror = () => (++attempt < ENDPOINTS.length ? tryOne()
                                                       : reject(new Error(`tuile ${z}/${x}/${y}`)));
      img.src = `${ENDPOINTS[attempt]}/${z}/${x}/${y}.png`;
    };
    tryOne();
  });
}

/**
 * Télécharge le relief de la zone et remplit `grid.slope` (pente en %).
 * @returns {{ok:boolean, reason?:string, tiles?:number, zoom?:number,
 *             minAlt?:number, maxAlt?:number, meanSlope?:number}}
 */
export async function loadRelief(frame, grid, onProgress = () => {}) {
  const b = frame.b;
  const z = pickZoom(b);
  const tx0 = Math.floor(lon2tx(b.west, z)), tx1 = Math.floor(lon2tx(b.east, z));
  const ty0 = Math.floor(lat2ty(b.north, z)), ty1 = Math.floor(lat2ty(b.south, z));
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;

  /* Mosaïque des tuiles dans un seul canvas */
  const cv = document.createElement('canvas');
  cv.width = cols * TILE; cv.height = rows * TILE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  let loaded = 0;
  const total = cols * rows;
  try {
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        onProgress(`Relief : tuile ${loaded + 1}/${total}…`);
        const img = await loadTile(z, tx, ty);
        ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE);
        loaded++;
      }
    }
  } catch (e) {
    return { ok: false, reason: `relief indisponible (${e.message})` };
  }

  let data;
  try {
    data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  } catch {
    /* Canvas contaminé : le serveur n'a pas renvoyé les en-têtes CORS. */
    return { ok: false, reason: 'relief refusé par le serveur (CORS)' };
  }

  /* Altitude en mètres pour un pixel de la mosaïque */
  const scale = Math.pow(2, z);
  const alt = (px, py) => {
    if (px < 0) px = 0; else if (px >= cv.width) px = cv.width - 1;
    if (py < 0) py = 0; else if (py >= cv.height) py = cv.height - 1;
    const o = ((py | 0) * cv.width + (px | 0)) * 4;
    return data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
  };
  /* Coordonnée monde → pixel de la mosaïque */
  const toPix = (wx, wy) => {
    const [lat, lon] = frame.toLatLng(wx, wy);
    return [(lon2tx(lon, z) - tx0) * TILE, (lat2ty(lat, z) - ty0) * TILE];
  };

  /* Échantillonnage : altitude au centre de chaque cellule, puis gradient.
     On mesure sur un pas d'au moins la résolution réelle du modèle, sinon la
     pente n'est que du bruit de quantification. */
  const mPerPix = 156543.03392 * Math.cos(frame.lat0 * Math.PI / 180) / (scale * TILE);
  const step = Math.max(grid.cell, mPerPix);
  const W = grid.w, H = grid.h, c = grid.cell;
  let minAlt = Infinity, maxAlt = -Infinity, sum = 0;

  for (let cy = 0; cy < H; cy++) {
    const wy = (cy + 0.5) * c;
    for (let cx = 0; cx < W; cx++) {
      const wx = (cx + 0.5) * c;
      const [pxE, pyE] = toPix(wx + step, wy);
      const [pxW, pyW] = toPix(wx - step, wy);
      const [pxN, pyN] = toPix(wx, wy - step);
      const [pxS, pyS] = toPix(wx, wy + step);
      const dzx = (alt(pxE, pyE) - alt(pxW, pyW)) / (2 * step);
      const dzy = (alt(pxS, pyS) - alt(pxN, pyN)) / (2 * step);
      const grade = Math.min(255, Math.round(Math.hypot(dzx, dzy) * 100));
      grid.slope[cy * W + cx] = grade;
      sum += grade;
      const a = alt(...toPix(wx, wy));
      if (a < minAlt) minAlt = a;
      if (a > maxAlt) maxAlt = a;
    }
  }

  grid.hasRelief = true;
  grid.version++;                 // force le recalcul de la pénibilité
  return {
    ok: true, tiles: total, zoom: z,
    minAlt: Math.round(minAlt), maxAlt: Math.round(maxAlt),
    meanSlope: +(sum / grid.n).toFixed(1),
  };
}
