/* ═══════════════════════════════════════════════════════
   ai-command.js — commandement délégué à un LLM (optionnel)
   Le compte rendu de situation part vers Gemini, OpenAI ou Claude,
   qui répond par une liste d'ordres en JSON. Ces ordres passent par
   exactement le même exécuteur que la doctrine locale, avec ses
   garde-fous : le modèle propose, la simulation dispose.

   ⚠ La clé d'API reste dans le navigateur (localStorage) et part
   directement chez le fournisseur. Elle n'est jamais écrite dans le
   dépôt ni transmise ailleurs. Sur un poste partagé, préférer la
   doctrine locale.
   ═══════════════════════════════════════════════════════ */

import { situationReport, executeOrder, logCommand } from './commander.js';

/* ── Fournisseurs ────────────────────────────────────── */
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyHint: 'Clé AI Studio (aistudio.google.com/apikey)',
    async call(cfg, system, user, signal) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) throw new Error(await describe(res));
      const j = await res.json();
      return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    },
  },

  openai: {
    label: 'OpenAI (ChatGPT)',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
    keyHint: 'Clé API (platform.openai.com/api-keys)',
    async call(cfg, system, user, signal) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: cfg.model, temperature: 0.4, max_tokens: 2048,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(await describe(res));
      const j = await res.json();
      return j.choices?.[0]?.message?.content || '';
    },
  },

  claude: {
    label: 'Anthropic Claude',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keyHint: 'Clé API (console.anthropic.com)',
    async call(cfg, system, user, signal) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.key,
          'anthropic-version': '2023-06-01',
          /* Sans cet en-tête, l'API refuse les appels venant d'un navigateur. */
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 4096,
          output_config: { effort: 'low' },   // décision de jeu : latence > profondeur
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(await describe(res));
      const j = await res.json();
      if (j.stop_reason === 'refusal') throw new Error('requête déclinée par le modèle');
      return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    },
  },
};

async function describe(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.error?.message || j.error?.type || JSON.stringify(j).slice(0, 200);
  } catch { detail = await res.text().catch(() => ''); }
  if (res.status === 401 || res.status === 403) return `clé refusée (HTTP ${res.status})`;
  if (res.status === 429) return 'quota ou cadence dépassée (HTTP 429)';
  return `HTTP ${res.status} — ${detail}`.trim();
}

/* ── Consigne ────────────────────────────────────────── */
const SYSTEM_PROMPT = `Tu es l'officier commandant les forces armées dans une simulation d'épidémie zombie.
Tu reçois un compte rendu de situation en JSON et tu réponds UNIQUEMENT par un objet JSON, sans texte autour.

Format de réponse :
{
  "analyse": "une phrase courte sur la situation",
  "ordres": [ { "type": "...", "x": 0, "y": 0, "escouade": 3, "raison": "..." } ]
}

Types d'ordres disponibles :
- "base"        : établir la base (une seule fois). x, y
- "evac"        : hélicoptère d'évacuation. x, y
- "frappe"      : frappe aérienne. x, y — REFUSÉE s'il y a des amis ou des civils dans le rayon
- "largage"     : munitions parachutées. x, y
- "barrage"     : barrage routier. x, y (doit tomber sur une route)
- "escorte"     : escouade regroupe et met les civils à l'abri. escouade, x, y (destination)
- "ratissage"   : escouade nettoie un secteur. escouade, x, y
- "patrouille"  : escouade patrouille une zone. escouade, x, y, rayon
- "garnison"    : escouade défend la base. escouade
- "libre"       : escouade rendue à son initiative. escouade

Règles :
- Les coordonnées sont en mètres, dans les limites de "zone".
- Ne dépense que les moyens listés dans "moyens_disponibles".
- Priorité absolue : sauver des civils. Les frappes servent à dégager un axe, jamais près d'amis.
- Au plus 4 ordres par tour. Si rien d'utile, renvoie une liste vide.
- Chaque ordre porte une "raison" de quelques mots.`;

/* ── Appel ───────────────────────────────────────────── */

/** Extrait le premier objet JSON d'une réponse, même entourée de texte. */
function extractJSON(text) {
  if (!text) throw new Error('réponse vide');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('aucun JSON dans la réponse');
  /* Balayage avec compteur d'accolades : tolère du texte après l'objet. */
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('JSON incomplet');
}

/**
 * Interroge le fournisseur configuré et applique les ordres retournés.
 * Ne lance jamais : toute erreur est journalisée et la simulation continue
 * avec sa doctrine locale au tour suivant.
 */
export async function requestOrders(sim, cfg) {
  const C = sim.command;
  if (C.ai.busy) return;
  const provider = PROVIDERS[cfg.provider];
  if (!provider) { C.ai.lastError = 'fournisseur inconnu'; return; }
  if (!cfg.key) { C.ai.lastError = 'aucune clé renseignée'; return; }

  C.ai.busy = true;
  C.ai.nextT = sim.time + Math.max(10, cfg.period);
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 30000);

  try {
    const sitrep = situationReport(sim);
    const raw = await provider.call(cfg, SYSTEM_PROMPT, JSON.stringify(sitrep), ctrl.signal);
    const parsed = extractJSON(raw);
    C.ai.calls++;
    C.ai.lastError = null;

    if (parsed.analyse) logCommand(sim, String(parsed.analyse).slice(0, 200), 'analysis');

    const orders = Array.isArray(parsed.ordres) ? parsed.ordres
                 : Array.isArray(parsed.orders) ? parsed.orders : [];
    if (!orders.length) { logCommand(sim, 'Aucun ordre ce tour.', 'info'); return; }

    for (const o of orders.slice(0, 4)) {
      const res = executeOrder(sim, o);
      const why = o.raison ? ` (${String(o.raison).slice(0, 80)})` : '';
      logCommand(sim, res.ok ? res.text + why : `Ordre écarté — ${res.text}.`,
                 res.ok ? 'order' : 'reject');
    }
  } catch (err) {
    C.ai.lastError = err.name === 'AbortError' ? 'délai dépassé (30 s)' : err.message;
    logCommand(sim, `Liaison avec l'état-major rompue : ${C.ai.lastError}`, 'alert');
  } finally {
    clearTimeout(killer);
    C.ai.busy = false;
  }
}
