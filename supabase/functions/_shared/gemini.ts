// supabase/functions/_shared/gemini.ts
// ============================================================
// GEMINI ENGINE — Rotation intelligente modèles × API Keys
// Stratégie : model1/key1 → model2/key1 → model3/key1
//           → model1/key2 → model2/key2 → ... → throw
// ============================================================

// ── Modèles par ordre de préférence ─────────────────────────
const GEMINI_MODELS = [
  'gemini-3-flash-preview',      // 1er choix — le plus puissant
  'gemini-2.5-flash-lite', // 2ème — rapide/léger
  'gemini-2.5-flash',                    // 3ème — stable/fallback
];

// ── Lecture des clés API (séparées par virgule) ──────────────
function getApiKeys(): string[] {
  const raw = Deno.env.get('GEMINI_API_KEY') ?? '';
  return raw
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

// ── Erreurs qui méritent un retry (quota/rate limit) ─────────
function isRetryableError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 503) return true;
  if (status === 500 && body.includes('quota')) return true;
  if (body.includes('RESOURCE_EXHAUSTED')) return true;
  if (body.includes('UNAVAILABLE')) return true;
  return false;
}

// ── Appel vers un modèle/clé précis ─────────────────────────
async function callGeminiOnce(
  apiKey: string,
  model: string,
  payload: Record<string, unknown>
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    const err = new Error(`[${model}] HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    (err as any).status = res.status;
    (err as any).body = bodyText;
    (err as any).retryable = isRetryableError(res.status, bodyText);
    throw err;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`[${model}] Réponse non-JSON`);
  }

  const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = (data as any)?.candidates?.[0]?.finishReason;
    if (reason === 'SAFETY') throw new Error(`[${model}] Contenu bloqué (SAFETY)`);
    throw new Error(`[${model}] Réponse vide — ${JSON.stringify(data).slice(0, 150)}`);
  }

  return text.trim();
}

// ── Appel principal avec rotation clés × modèles ─────────────
export async function callGemini(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  memorySummary: string
): Promise<string> {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) throw new Error('GEMINI_API_KEY non configurée');

  const payload = buildPayload(userMessage, history, memorySummary);
  const errors: string[] = [];

  // Rotation : pour chaque clé → essayer chaque modèle dans l'ordre
  for (const apiKey of apiKeys) {
    for (const model of GEMINI_MODELS) {
      try {
        console.log(`🔄 Gemini: essai ${model} / key …${apiKey.slice(-6)}`);
        const result = await callGeminiOnce(apiKey, model, payload);
        console.log(`✅ Gemini: succès avec ${model}`);
        return result;
      } catch (err: any) {
        const msg = `[key …${apiKey.slice(-6)}][${model}] ${err.message}`;
        errors.push(msg);
        console.warn(`⚠️ Gemini échec: ${msg}`);

        // Clé invalide → inutile d'essayer les autres modèles avec cette clé
        if (err.status === 401 || err.status === 403) {
          console.warn(`🔑 Clé invalide — passage à la clé suivante`);
          break;
        }

        // Sinon (quota/rate limit/erreur réseau) → modèle suivant
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  throw new Error(`Gemini: tous les providers ont échoué.\n${errors.join('\n')}`);
}

// ── Parse la réponse JSON de Gemini ──────────────────────────
export function parseGeminiResponse(raw: string): {
  reply: string;
  detected_language: string;
  intent: string;
  next_action: string;
} {
  try {
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // Fallback si JSON cassé
    return {
      reply: raw,
      detected_language: 'fr',
      intent: 'info',
      next_action: 'waiting_verification',
    };
  }
}

// ── Construire le payload Gemini ──────────────────────────────
function buildPayload(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  memorySummary: string
): Record<string, unknown> {
  const systemText = memorySummary
    ? `${SYSTEM_INSTRUCTION}\n\n────────────────────────\nMÉMOIRE CLIENT (contexte mémorisé):\n${memorySummary}\n────────────────────────`
    : SYSTEM_INSTRUCTION;

  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  return {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: 600,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
}

