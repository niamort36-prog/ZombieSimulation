/* ═══════════════════════════════════════════════════════
   sprites.js — banque de sprites pixel art, vue de dessus
   Chaque sprite est décrit par une grille de caractères, orientée
   vers l'EST (+x) ; le moteur de rendu la fait pivoter. Elle est
   rasterisée une fois dans un canvas hors écran à raison d'un pixel
   par caractère, puis tirée au zoom voulu sans lissage — ce qui
   préserve les arêtes franches du pixel art.
   ═══════════════════════════════════════════════════════ */

/* ── Palette ─────────────────────────────────────────── */
const PAL = {
  '.': null,                    // transparent
  o: '#2f3438',                 // vêtement sombre (référence)
  O: '#23272a',                 // ombre du vêtement
  s: '#c89b82',                 // peau
  S: '#b0836b',                 // peau ombrée
  h: '#3a2c22',                 // cheveux
  w: '#15181a',                 // arme, métal
  W: '#0d0f10',                 // canon
  r: '#7a2630',                 // sang / blessure
};

/* Teintes de vêtement : un civil au hasard prend l'une d'elles, ce qui
   évite une foule uniforme sans coûter le moindre calcul au rendu. */
const CIV_COLORS = ['#2f3438', '#4a3b52', '#5a4436', '#2f4858', '#6b4a4a', '#455a4a', '#7a6a4a', '#3f4a55'];
const CIV_SHADE  = ['#23272a', '#382c3e', '#443428', '#233642', '#523737', '#334336', '#5c5038', '#2f3840'];
export const CIV_VARIANTS = CIV_COLORS.length;

const CAR_COLORS = ['#b9c2c9', '#8a3f3f', '#3a5a7a', '#4a5540', '#c9b06a', '#2f3438'];
const CAR_SHADE  = ['#8d959b', '#6a2f2f', '#2c4459', '#38402f', '#9b8750', '#23272a'];
export const CAR_VARIANTS = CAR_COLORS.length;

/* ── Silhouettes ─────────────────────────────────────── */
/* Humain de base : épaules perpendiculaires à la marche, tête au centre,
   mains visibles de part et d'autre — comme sur la référence. */
const HUMAN = [
  '..ooo..',
  '.OoooO.',
  '.ooooos',
  '.oshso.',
  '.osssS.',
  '.oshso.',
  '.ooooos',
  '.OoooO.',
  '..ooo..',
];

/* Civil armé : les bras se rejoignent devant, arme courte tenue à deux mains */
const HUMAN_ARMED = [
  '..ooo....',
  '.OoooO...',
  '.oooooo..',
  '.oshsosww',
  '.osssSsWW',
  '.oshsosww',
  '.oooooo..',
  '.OoooO...',
  '..ooo....',
];

/* Militaire : casque (pas de peau visible), fusil long épaulé */
const SOLDIER = [
  '..ooo......',
  '.OoooO.....',
  '.ooooooo...',
  '.ohhhoosww.',
  '.ohhhooWWWW',
  '.ohhhoosww.',
  '.ooooooo...',
  '.OoooO.....',
  '..ooo......',
];

/* Commandant : béret, jumelles à la ceinture, arme courte. Plus large
   d'épaules que le soldat de base pour se distinguer d'un coup d'œil. */
const OFFICER = [
  '..oooo.....',
  '.OooooO....',
  '.oooooooww.',
  '.ohhhhoosWW',
  '.ohhhhoosww',
  '.ohhhhoo...',
  '.oooooooo..',
  '.OooooO....',
  '..oooo.....',
];

/* Zombie : bras tendus vers l'avant, démarche désaxée, taches de sang */
const ZOMBIE = [
  '..ooo....',
  '.OoooO...',
  '.ooooo.ss',
  '.oshso...',
  '.osssS...',
  '.oshso...',
  '.rooooo.s',
  '.OoooO.ss',
  '..ooo....',
];

/* Corps à terre : silhouette étalée, bras écartés */
const DOWNED = [
  '.s.....s.',
  '.ssooosss',
  '..ooooo..',
  '.rossso..',
  '.roSSSo..',
  '.rossso..',
  '..ooooo..',
  '.ssooosss',
  '.s.....s.',
];

/* ── Véhicules (orientés vers l'est) ─────────────────── */
const CAR = [
  '...cccccccc..',
  '..cCcccccccC.',
  '.cccggggcccc.',
  'ccccggggccccl',
  'ccccggggccccl',
  '.cccggggcccc.',
  '..cCcccccccC.',
  '...cccccccc..',
];

const VAN = [
  '..cccccccccc..',
  '.cCccccccccccC',
  'cccccccggggccl',
  'cccccccggggccl',
  'cccccccggggccl',
  'cccccccggggccl',
  '.cCccccccccccC',
  '..cccccccccc..',
];

const TRUCK = [
  '..cccccccccccccc..',
  '.cCcccccccccccccCc',
  'cbbbbbbbbccggggccl',
  'cbbbbbbbbccggggccl',
  'cbbbbbbbbccggggccl',
  'cbbbbbbbbccggggccl',
  '.cCcccccccccccccCc',
  '..cccccccccccccc..',
];

/* Hélicoptère : fuselage et poutre de queue. Le rotor reste dessiné en
   vectoriel par le moteur de rendu, puisqu'il tourne. */
const HELI = [
  '................',
  '.........cc.....',
  'ttttttcccccccc..',
  'tttttcccggggccc.',
  'tttttcccggggccc.',
  'ttttttcccccccc..',
  '.........cc.....',
  '................',
];

const CRATE = [
  '.tttttt.',
  'tcccccct',
  'tcttttct',
  'tcttttct',
  'tcttttct',
  'tcttttct',
  'tcccccct',
  '.tttttt.',
];

/* ═══ Rasterisation ═══════════════════════════════════ */

/**
 * Transforme une grille de caractères en canvas hors écran (1 px / caractère).
 * `ax` est l'abscisse du point d'ancrage en pixels de sprite : elle vaut le
 * centre du corps, PAS le centre de l'image — sinon un fusil qui dépasse vers
 * l'avant décalerait le soldat vers l'arrière de sa position réelle.
 */
function raster(rows, palette, ax = null, ay = null) {
  const h = rows.length, w = Math.max(...rows.map(r => r.length));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const col = palette[row[x] ?? '.'];
      if (!col) continue;
      const o = (y * w + x) * 4;
      d[o] = parseInt(col.slice(1, 3), 16);
      d[o + 1] = parseInt(col.slice(3, 5), 16);
      d[o + 2] = parseInt(col.slice(5, 7), 16);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cv.ax = ax ?? w / 2;
  cv.ay = ay ?? h / 2;
  return cv;
}

/* Ancrage commun aux silhouettes humaines : centre du torse. */
const BODY_ANCHOR = [3.5, 4.5];

/** Palette dérivée : remplace le vêtement et son ombre. */
const clothed = (body, shade, extra = {}) => ({ ...PAL, o: body, O: shade, ...extra });

/** Silhouette noire d'un sprite, pour l'ombre portée. */
function silhouette(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const cx = c.getContext('2d');
  cx.drawImage(src, 0, 0);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * Rassemble tous les sprites dans une seule image.
 * Dessiner depuis 16 canvas différents faisait tripler le temps de rendu :
 * le contexte 2D rebascule de texture source à chaque changement. Avec un
 * atlas unique, toute la scène se dessine depuis la même image.
 */
function packAtlas(items) {
  const PADDING = 1;
  const maxH = Math.max(...items.map(i => i.cv.height));
  const totalW = items.reduce((a, i) => a + i.cv.width + PADDING, PADDING);
  const atlas = document.createElement('canvas');
  atlas.width = totalW;
  atlas.height = maxH * 2 + PADDING * 3;
  const ctx = atlas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const shadowY = maxH + PADDING * 2;
  let x = PADDING;
  for (const it of items) {
    ctx.drawImage(it.cv, x, PADDING);
    ctx.drawImage(silhouette(it.cv), x, shadowY);
    it.frame = {
      atlas, sx: x, sy: PADDING, shy: shadowY,
      w: it.cv.width, h: it.cv.height,
      ax: it.cv.ax, ay: it.cv.ay,
    };
    x += it.cv.width + PADDING;
  }
  return atlas;
}

let CACHE = null;

/** Construit la banque complète (appelée une fois, paresseusement). */
export function buildSprites() {
  if (CACHE) return CACHE;
  const S = {};

  /* Civils : une entrée par teinte de vêtement, armés ou non */
  S.civ = [];
  S.civArmed = [];
  for (let i = 0; i < CIV_VARIANTS; i++) {
    const p = clothed(CIV_COLORS[i], CIV_SHADE[i]);
    S.civ.push(raster(HUMAN, p, ...BODY_ANCHOR));
    S.civArmed.push(raster(HUMAN_ARMED, p, ...BODY_ANCHOR));
  }

  /* Forces de l'ordre */
  const polPal = clothed('#243a5e', '#18273f', { h: '#101c30' });
  const milPal = clothed('#4a5a3a', '#36452a', { h: '#3d4a2f' });
  S.pol = raster(HUMAN_ARMED, polPal, ...BODY_ANCHOR);
  S.polUnarmed = raster(HUMAN, polPal, ...BODY_ANCHOR);
  S.mil = raster(SOLDIER, milPal, ...BODY_ANCHOR);
  S.milUnarmed = raster(HUMAN, milPal, ...BODY_ANCHOR);
  /* Béret et tenue plus sombres : l'officier doit se repérer dans la masse. */
  S.officer = raster(OFFICER, clothed('#3d4a2c', '#2b3520', { h: '#5c2f2f' }), ...BODY_ANCHOR);

  /* Zombies */
  S.zomSlow = raster(ZOMBIE, clothed('#4a4550', '#332f3a', { s: '#7d8f6a', S: '#63754f', h: '#2b3324' }), ...BODY_ANCHOR);
  S.zomFast = raster(ZOMBIE, clothed('#5c3a55', '#40283b', { s: '#93a870', S: '#748a55', h: '#31371f' }), ...BODY_ANCHOR);

  /* Blessés et dépouilles (silhouette étalée : ancrage au centre) */
  S.downedCiv = raster(DOWNED, clothed('#4a4038', '#332c26'));
  S.corpseHuman = raster(DOWNED, clothed('#3a332c', '#26211c', { s: '#8a7264', S: '#6e5a4f', r: '#5a1c24' }));
  S.corpseZom = raster(DOWNED, clothed('#332f3a', '#242029', { s: '#5f6f50', S: '#4a5840', r: '#4a1820' }));

  /* Véhicules */
  const vehPal = (body, shade, glass = '#1b2833') => ({
    ...PAL, c: body, C: shade, g: glass, l: '#ffe9a8', b: '#6b5a3a', t: '#8a7448',
  });
  S.car = [];
  for (let i = 0; i < CAR_VARIANTS; i++) S.car.push(raster(CAR, vehPal(CAR_COLORS[i], CAR_SHADE[i])));
  S.van = raster(VAN, vehPal('#5c6b4a', '#414d35'));
  S.truck = raster(TRUCK, vehPal('#4a5540', '#343d2d'));
  S.supply = raster(TRUCK, vehPal('#6b5a2f', '#4c4021'));
  S.wreckCar = raster(CAR, vehPal('#2a2622', '#1b1815', '#0f1315'));
  S.wreckTruck = raster(TRUCK, vehPal('#2a2622', '#1b1815', '#0f1315'));

  S.crate = raster(CRATE, { ...PAL, c: '#7a6a3a', t: '#d9c47a' });
  /* Ancrage sur le fuselage (x≈11), pas au milieu de l'image : la poutre de
     queue tire le centre géométrique vers l'arrière. */
  S.heli = raster(HELI, { ...PAL, c: '#2f3b30', g: '#16202a', t: '#26301f' }, 11, 4);

  /* Tout empaqueter, puis remplacer les canvas par leurs descripteurs. */
  const items = [];
  const collect = (obj) => {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (Array.isArray(v)) v.forEach((cv, i) => items.push({ cv, set: (fr) => { v[i] = fr; } }));
      else items.push({ cv: v, set: (fr) => { obj[key] = fr; } });
    }
  };
  collect(S);
  packAtlas(items);
  for (const it of items) it.set(it.frame);

  CACHE = S;
  return S;
}

/* Un index de teinte absent ou hors bornes ne doit jamais renvoyer `undefined`
   au moteur de rendu : une entité mal formée effacerait toute l'image. */
const pickVariant = (arr, i) => arr[(((i | 0) % arr.length) + arr.length) % arr.length];

/** Sprite correspondant à une entité. */
export function spriteFor(S, e, KIND, ST) {
  if (e.state === ST.DOWNED) return S.downedCiv;
  switch (e.kind) {
    case KIND.ZOM: return e.zType === 'fast' ? S.zomFast : S.zomSlow;
    case KIND.POL: return e.weapon ? S.pol : S.polUnarmed;
    case KIND.MIL:
      if (e.commander) return S.officer;
      return e.weapon ? S.mil : S.milUnarmed;
    default:
      return pickVariant(e.weapon ? S.civArmed : S.civ, e.variant);
  }
}

export function spriteForVehicle(S, v) {
  if (!v.alive) return v.type === 'car' ? S.wreckCar : S.wreckTruck;
  switch (v.type) {
    case 'car': return pickVariant(S.car, v.variant);
    case 'van': return S.van;
    case 'supply': return S.supply;
    default: return S.truck;
  }
}
