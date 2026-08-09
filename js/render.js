/* ═══════════════════════════════════════════════════════
   render.js — rendu Canvas 2D par-dessus la carte Leaflet
   Projection : origine du repère monde → point conteneur
   Leaflet, échelle uniforme px/m (valable localement en
   Web Mercator).
   ═══════════════════════════════════════════════════════ */

import { KIND, ST, T, UNIT, WEAPON, BLOCK_MOVE } from './config.js';

/* Un humain mesure moins d'un mètre de large : à l'échelle métrique exacte il
   occupe ~1 px au zoom 17, autrement dit il est invisible. Les sprites sont
   donc dessinés comme des pions de carte — jamais en dessous de cette taille —
   et ne repassent à l'échelle réelle qu'une fois très zoomé. */
const MIN_SPRITE_PX = 4.4;
const MIN_CORPSE_PX = 2.8;
/* En dessous de cette échelle (px/m) on ne dessine plus que des points colorés :
   la zone entière tient dans quelques centaines de pixels. */
const TINY_SCALE = 0.25;

export class Renderer {
  constructor(canvas, map, sim) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.sim = sim;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.opts = { terrain: false, los: false, paths: false, bars: true, blood: true, spriteScale: 1 };
    this.terrainCache = null;
    this.terrainVersion = -1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    this.W = r.width; this.H = r.height;
  }

  /** Met à jour origine + échelle depuis l'état courant de la carte. */
  syncProjection() {
    const s = this.sim;
    if (!s.frame) return false;
    const f = s.frame;
    const o = this.map.latLngToContainerPoint(L.latLng(f.lat0, f.lon0));
    const [lat2, lon2] = f.toLatLng(100, 0);
    const p2 = this.map.latLngToContainerPoint(L.latLng(lat2, lon2));
    this.ox = o.x; this.oy = o.y;
    this.k = (p2.x - o.x) / 100;              // pixels par mètre
    return this.k > 0;
  }

  px(x) { return this.ox + x * this.k; }
  py(y) { return this.oy + y * this.k; }

  /** Rectangle monde visible (avec marge). */
  viewport() {
    const m = 60 / this.k;
    return {
      x0: (-this.ox) / this.k - m, y0: (-this.oy) / this.k - m,
      x1: (this.W - this.ox) / this.k + m, y1: (this.H - this.oy) / this.k + m,
    };
  }

  draw() {
    const ctx = this.ctx, s = this.sim;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (!s.ready || !this.syncProjection()) return;

    const k = this.k, vp = this.viewport();
    const vis = (x, y, pad = 4) => x > vp.x0 - pad && x < vp.x1 + pad && y > vp.y0 - pad && y < vp.y1 + pad;

    if (this.opts.terrain) this.drawTerrain();
    if (this.opts.blood) this.drawBlood(vp);
    this.drawCorpses(vp);
    this.drawCrates(vp);
    this.drawStrikes();
    if (this.opts.paths) this.drawPaths(vp);
    this.drawIndoor(vp);
    this.drawEntities(vp, vis);
    this.drawHelis();
    this.drawEffects();
  }

  /* ── Grille de navigation (debug) ───────────────────── */
  drawTerrain() {
    const s = this.sim, g = s.grid;
    if (!this.terrainCache || this.terrainVersion !== g.version) {
      const c = document.createElement('canvas');
      c.width = g.w; c.height = g.h;
      const cx = c.getContext('2d');
      const img = cx.createImageData(g.w, g.h);
      const d = img.data;
      for (let i = 0; i < g.n; i++) {
        const f = g.flags[i], o = i * 4;
        if (f & T.BUILDING)      { d[o] = 220; d[o+1] = 90;  d[o+2] = 90;  d[o+3] = 110; }
        else if (f & T.WATER)    { d[o] = 60;  d[o+1] = 140; d[o+2] = 255; d[o+3] = 120; }
        else if (f & T.WALL)     { d[o] = 255; d[o+1] = 160; d[o+2] = 60;  d[o+3] = 150; }
        else if (f & T.FENCE)    { d[o] = 255; d[o+1] = 220; d[o+2] = 90;  d[o+3] = 110; }
        else if (f & T.RUBBLE)   { d[o] = 150; d[o+1] = 140; d[o+2] = 130; d[o+3] = 120; }
        else if (f & T.ROAD)     { d[o] = 120; d[o+1] = 255; d[o+2] = 170; d[o+3] = 55; }
      }
      cx.putImageData(img, 0, 0);
      this.terrainCache = c;
      this.terrainVersion = g.version;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const w = this.sim.frame.width * this.k, h = this.sim.frame.height * this.k;
    ctx.drawImage(this.terrainCache, this.px(0), this.py(0), w, h);
    ctx.restore();
  }

  /* ── Décals ─────────────────────────────────────────── */
  drawBlood(vp) {
    const ctx = this.ctx, k = this.k;
    if (k < 0.12) return;
    ctx.save();
    for (const b of this.sim.blood) {
      if (b.x < vp.x0 || b.x > vp.x1 || b.y < vp.y0 || b.y > vp.y1) continue;
      ctx.fillStyle = b.c || 'rgba(150,20,25,0.5)';
      ctx.beginPath();
      ctx.arc(this.px(b.x), this.py(b.y), Math.max(1.8, b.r * k * 2.2), 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  drawCorpses(vp) {
    const ctx = this.ctx, k = this.k;
    if (k < TINY_SCALE * 0.6) return;
    const r = Math.max(MIN_CORPSE_PX, 0.45 * k * 2.2) * this.opts.spriteScale;
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (const c of this.sim.corpses) {
      if (c.x < vp.x0 || c.x > vp.x1 || c.y < vp.y0 || c.y > vp.y1) continue;
      ctx.fillStyle = c.kind === KIND.ZOM ? '#4a2f66' : '#5a4a3a';
      ctx.beginPath();
      ctx.ellipse(this.px(c.x), this.py(c.y), r * 1.4, r * 0.8, c.dir, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ── Civils à l'abri ────────────────────────────────── */
  drawIndoor(vp) {
    const ctx = this.ctx, k = this.k;
    if (k < TINY_SCALE) return;
    ctx.save();
    for (const b of this.sim.buildings) {
      const n = b.occupants.length;
      if (!n) continue;
      if (b.c.x < vp.x0 || b.c.x > vp.x1 || b.c.y < vp.y0 || b.c.y > vp.y1) continue;
      const x = this.px(b.c.x), y = this.py(b.c.y);
      const r = Math.max(4, Math.min(12, 3 + Math.sqrt(n) * 2.4));
      ctx.fillStyle = 'rgba(255,212,94,0.22)';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,212,94,0.75)'; ctx.lineWidth = 1.3;
      ctx.stroke();
      /* pastille centrale : sans elle, un bâtiment habité se confond avec
         l'imagerie satellite */
      ctx.fillStyle = 'rgba(255,224,140,0.9)';
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 6.283); ctx.fill();
      if (k > 1.1 && n > 1) {
        ctx.fillStyle = 'rgba(255,236,190,0.85)';
        ctx.font = '9px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n, x, y);
      }
    }
    ctx.restore();
  }

  /* ── Entités ────────────────────────────────────────── */
  drawEntities(vp, vis) {
    const ctx = this.ctx, k = this.k, s = this.sim;
    const sc = this.opts.spriteScale;
    const tiny = k < TINY_SCALE;

    for (const e of s.entities) {
      if (e.indoor || e.state === ST.EVACUATED) continue;
      if (!vis(e.x, e.y)) continue;
      const x = this.px(e.x), y = this.py(e.y);
      const r = (tiny ? 2.6 : Math.max(MIN_SPRITE_PX, e.radius * k * 2.2)) * sc;

      /* cône de vision */
      if (this.opts.los && e.alive && !tiny) {
        const range = (e.kind === KIND.ZOM ? e.sight : Math.min(e.sight, e.weapon ? WEAPON[e.weapon].range : 40)) * k;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, range, e.dir - e.fov / 2, e.dir + e.fov / 2);
        ctx.closePath();
        ctx.fillStyle = e.kind === KIND.ZOM ? 'rgba(157,92,240,0.07)' : 'rgba(120,200,255,0.06)';
        ctx.fill();
      }

      if (e.state === ST.DOWNED) {
        ctx.fillStyle = '#8b2f3a';
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.5, r * 0.75, e.dir, 0, 6.283);
        ctx.fill();
        /* compte à rebours d'infection */
        if (!tiny) {
          ctx.strokeStyle = '#e05a7a'; ctx.lineWidth = 1.5;
          const p = 1 - e.turnT / Math.max(0.001, s.params.turnDelay * 1.5);
          ctx.beginPath(); ctx.arc(x, y, r * 2, -1.57, -1.57 + 6.283 * p); ctx.stroke();
        }
        continue;
      }

      this.sprite(ctx, e, x, y, r, tiny);

      /* barres vie / munitions */
      if (this.opts.bars && !tiny) {
        if (e.hp < e.maxHp) {
          const w = r * 3, h = 1.8;
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x - w / 2, y - r * 2.6, w, h);
          ctx.fillStyle = e.hp / e.maxHp > 0.5 ? '#7ee787' : e.hp / e.maxHp > 0.25 ? '#ffb454' : '#ff5b5b';
          ctx.fillRect(x - w / 2, y - r * 2.6, w * (e.hp / e.maxHp), h);
        }
        if (e.weapon && k > 1) {
          const w = WEAPON[e.weapon];
          const total = e.mag + e.reserve;
          if (total <= 0) {
            ctx.fillStyle = '#ff5b5b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center';
            ctx.fillText('✕', x, y - r * 3.2);
          } else if (e.reloadT > 0) {
            ctx.fillStyle = '#ffb454'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center';
            ctx.fillText('⟳', x, y - r * 3.2);
          }
        }
      }
    }
  }

  /** Petit sprite vu du dessus : épaules + tête + orientation. */
  sprite(ctx, e, x, y, r, tiny) {
    const u = UNIT[e.kind];
    let body = u.color;
    if (e.kind === KIND.ZOM) body = e.zType === 'fast' ? '#c34bd8' : '#8f4bd8';
    else if (e.kind === KIND.CIV && e.weapon) body = '#ffae4e';

    if (tiny) {
      ctx.fillStyle = body;
      ctx.fillRect(x - r * 0.6, y - r * 0.6, r * 1.2, r * 1.2);
      return;
    }

    const cos = Math.cos(e.dir), sin = Math.sin(e.dir);

    /* ombre au sol */
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(x + 0.6, y + 0.8, r * 1.15, r * 0.95, 0, 0, 6.283); ctx.fill();

    /* épaules */
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.05, r * 0.78, e.dir, 0, 6.283);
    ctx.fill();

    /* tête */
    ctx.fillStyle = e.kind === KIND.ZOM ? '#6f8f5a' : '#e3b98d';
    ctx.beginPath();
    ctx.arc(x + cos * r * 0.15, y + sin * r * 0.15, r * 0.52, 0, 6.283);
    ctx.fill();

    /* arme / bras tendus */
    if (e.weapon && e.kind !== KIND.ZOM) {
      ctx.strokeStyle = '#20242b';
      ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.beginPath();
      ctx.moveTo(x + cos * r * 0.4, y + sin * r * 0.4);
      ctx.lineTo(x + cos * r * 1.9, y + sin * r * 1.9);
      ctx.stroke();
    } else if (e.kind === KIND.ZOM) {
      /* bras tendus du zombie */
      ctx.strokeStyle = '#5c7a49';
      ctx.lineWidth = Math.max(0.8, r * 0.25);
      const p = -sin, q = cos;
      ctx.beginPath();
      ctx.moveTo(x + p * r * 0.6, y + q * r * 0.6);
      ctx.lineTo(x + cos * r * 1.5 + p * r * 0.5, y + sin * r * 1.5 + q * r * 0.5);
      ctx.moveTo(x - p * r * 0.6, y - q * r * 0.6);
      ctx.lineTo(x + cos * r * 1.5 - p * r * 0.5, y + sin * r * 1.5 - q * r * 0.5);
      ctx.stroke();
    }

    /* liseré d'état */
    if (e.state === ST.FLEE) {
      ctx.strokeStyle = 'rgba(255,180,84,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, 6.283); ctx.stroke();
    } else if (e.state === ST.ATTACK && e.kind !== KIND.ZOM) {
      ctx.strokeStyle = 'rgba(255,91,91,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, 6.283); ctx.stroke();
    } else if (e.state === ST.BOARD) {
      ctx.strokeStyle = 'rgba(78,224,192,0.95)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 6.283); ctx.stroke();
    }
  }

  /* ── Trajectoires ───────────────────────────────────── */
  drawPaths(vp) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    for (const e of this.sim.entities) {
      if (!e.path || e.indoor) continue;
      if (e.x < vp.x0 || e.x > vp.x1 || e.y < vp.y0 || e.y > vp.y1) continue;
      ctx.strokeStyle = e.kind === KIND.ZOM ? 'rgba(157,92,240,0.4)' : 'rgba(120,200,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(this.px(e.x), this.py(e.y));
      for (let i = e.pathI; i < e.path.length; i++)
        ctx.lineTo(this.px(e.path[i].x), this.py(e.path[i].y));
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── Caisses / frappes / hélicos ────────────────────── */
  drawCrates(vp) {
    const ctx = this.ctx, k = this.k;
    for (const c of this.sim.crates) {
      const x = this.px(c.x), y = this.py(c.y);
      const s = Math.max(5, 2.4 * k);
      if (!c.landed) {
        /* parachute en descente */
        ctx.fillStyle = 'rgba(230,237,243,0.5)';
        ctx.beginPath(); ctx.arc(x, y - s * 2.2, s * 1.3, Math.PI, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(230,237,243,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - s * 1.2, y - s * 2.2); ctx.lineTo(x, y);
        ctx.moveTo(x + s * 1.2, y - s * 2.2); ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.fillStyle = '#7a6a3a'; ctx.strokeStyle = '#d9c47a'; ctx.lineWidth = 1.2;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      if (c.landed && k > 0.6) {
        ctx.fillStyle = '#d9c47a'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(c.uses, x, y + s * 1.6);
      }
    }
  }

  drawStrikes() {
    const ctx = this.ctx, k = this.k;
    for (const s of this.sim.strikes) {
      const x = this.px(s.x), y = this.py(s.y), r = s.r * k;
      const p = 1 - s.t / s.total;
      ctx.save();
      ctx.strokeStyle = `rgba(255,91,91,${0.45 + 0.4 * Math.abs(Math.sin(s.t * 6))})`;
      ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,91,91,0.9)';
      ctx.beginPath(); ctx.arc(x, y, r * (1 - p), 0, 6.283); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * .3, y); ctx.lineTo(x + r * .3, y);
      ctx.moveTo(x, y - r * .3); ctx.lineTo(x, y + r * .3);
      ctx.stroke();
      ctx.fillStyle = '#ff5b5b'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(s.t.toFixed(1) + 's', x, y - r - 6);
      ctx.restore();
    }
  }

  drawHelis() {
    const ctx = this.ctx, k = this.k, t = performance.now() / 1000;
    for (const h of this.sim.helis) {
      const x = this.px(h.x), y = this.py(h.y);
      const s = Math.max(9, 7 * k);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(h.dir);
      /* fuselage */
      ctx.fillStyle = '#2f3b30'; ctx.strokeStyle = '#7ee787'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.95, s * 0.42, 0, 0, 6.283); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.9, 0); ctx.lineTo(-s * 1.9, 0); ctx.lineWidth = s * 0.16;
      ctx.strokeStyle = '#2f3b30'; ctx.stroke();
      /* rotor */
      const a = t * 26;
      ctx.strokeStyle = 'rgba(230,237,243,0.5)'; ctx.lineWidth = 1.6;
      for (let i = 0; i < 2; i++) {
        const aa = a + i * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(aa) * s * 1.7, Math.sin(aa) * s * 1.7);
        ctx.lineTo(-Math.cos(aa) * s * 1.7, -Math.sin(aa) * s * 1.7);
        ctx.stroke();
      }
      ctx.restore();

      /* zone d'embarquement */
      if (h.state === 'landed') {
        ctx.strokeStyle = 'rgba(78,224,192,0.55)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(x, y, 6 * k, 0, 6.283); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#4ee0c0'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(`${h.aboard}/${h.capacity} · ${Math.max(0, h.waitT) | 0}s`, x, y - Math.max(14, 9 * k));
      } else if (h.state === 'inbound') {
        const lx = this.px(h.lz.x), ly = this.py(h.lz.y);
        ctx.strokeStyle = 'rgba(126,231,135,0.4)'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(lx, ly, 6 * k, 0, 6.283); ctx.stroke();
      }
    }
  }

  /* ── Effets ─────────────────────────────────────────── */
  drawEffects() {
    const ctx = this.ctx, k = this.k;
    for (const fx of this.sim.effects) {
      if (fx.type === 'tracer') {
        ctx.strokeStyle = `rgba(255,236,160,${Math.min(1, fx.t * 9)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(this.px(fx.x0), this.py(fx.y0));
        ctx.lineTo(this.px(fx.x1), this.py(fx.y1));
        ctx.stroke();
        ctx.fillStyle = `rgba(255,220,120,${Math.min(1, fx.t * 9)})`;
        ctx.beginPath(); ctx.arc(this.px(fx.x0), this.py(fx.y0), 2.2, 0, 6.283); ctx.fill();
      } else if (fx.type === 'boom') {
        const p = 1 - fx.t / fx.total;
        const r = fx.r * k * (0.35 + p * 0.9);
        const g = ctx.createRadialGradient(this.px(fx.x), this.py(fx.y), 0, this.px(fx.x), this.py(fx.y), Math.max(1, r));
        g.addColorStop(0, `rgba(255,240,190,${(1 - p) * 0.95})`);
        g.addColorStop(0.4, `rgba(255,150,40,${(1 - p) * 0.75})`);
        g.addColorStop(1, `rgba(90,60,50,0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(this.px(fx.x), this.py(fx.y), Math.max(1, r), 0, 6.283); ctx.fill();
      }
    }
  }
}
