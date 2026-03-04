// supabase/functions/_shared/gemini.ts
// ============================================================
// GEMINI ENGINE — Rotation intelligente modèles × API Keys
// ============================================================

// URL de votre instruction système hébergée sur GitHub
const SYSTEM_INSTRUCTION_URL = 'https://raw.githubusercontent.com/TeacherMada/botMessenger/main/system-instruction.md';

// Cache en mémoire pour éviter de re-télécharger à chaque appel
let cachedSystemInstruction: string | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 3600000; // 1 heure (en millisecondes)

// ── Charger l'instruction système depuis GitHub ─────────────
async function loadSystemInstruction(): Promise<string> {
  const now = Date.now();
  
  // Utiliser le cache si disponible et pas trop vieux
  if (cachedSystemInstruction && (now - lastFetchTime) < CACHE_DURATION) {
    console.log('📦 Utilisation instruction système en cache');
    return cachedSystemInstruction;
  }

  try {
    console.log('📥 Téléchargement instruction système depuis GitHub...');
    
    const response = await fetch(SYSTEM_INSTRUCTION_URL);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    
    // Mettre en cache
    cachedSystemInstruction = content;
    lastFetchTime = now;
    
    console.log('✅ Instruction système chargée avec succès');
    return content;
    
  } catch (error) {
    console.error('❌ Erreur chargement instruction système:', error);
    
    // Fallback : instruction minimale en cas d'échec
    return `You are "TSANTA", Senior Strategic Learning Advisor of TeacherMada.
Guide and convert conversations into premium learning engagement.
Be helpful, professional, and strategic.

Response format (STRICT JSON ONLY):
{
  "reply": "your response",
  "detected_language": "mg|fr|en",
  "intent": "greeting|learning|pricing|signup|comparison|objection|info|book",
  "next_action": "ask_question|present_offer|send_link|redirect_human|waiting_verification"
}`;
  }
}

// ── Modèles par ordre de préférence ─────────────────────────
const GEMINI_MODELS = [
  'gemini-3-flash-preview',           // 1er choix — le plus récent
  'gemini-2.5-flash',       // 2ème — rapide
  'gemini-2.5-flash-lite',             // 3ème — stable/fallback
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

// ── Construire le payload Gemini ──────────────────────────────
async function buildPayload(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  memorySummary: string
): Promise<Record<string, unknown>> {
  // ⚠️ IMPORTANT: Charger l'instruction depuis GitHub
  const systemInstruction = await loadSystemInstruction();
  
  const finalInstruction = memorySummary
    ? `${systemInstruction}\n\n────────────────────────\nMÉMOIRE CLIENT (contexte mémorisé):\n${memorySummary}\n────────────────────────`
    : systemInstruction;

  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  return {
    systemInstruction: { parts: [{ text: finalInstruction }] },
    contents,
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: 1000,
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

// ── Appel principal avec rotation clés × modèles ─────────────
// ── Appel principal avec rotation clés × modèles ─────────────
export async function callGemini(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  memorySummary: string
): Promise<{
  reply: string;
  detected_language: string;
  intent: string;
  next_action: string;
}> {

  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) throw new Error('GEMINI_API_KEY non configurée');

  const payload = await buildPayload(userMessage, history, memorySummary);
  const errors: string[] = [];

  for (const apiKey of apiKeys) {
    for (const model of GEMINI_MODELS) {
      try {

        const rawText = await callGeminiOnce(apiKey, model, payload);

        const parsed = parseGeminiResponse(rawText);

        // 🔥 Sécurisation ici
        const safeReply =
          parsed.reply ||
          (parsed as any).response ||
          (parsed as any).message ||
          rawText ||
          "Je n'ai pas pu générer une réponse correcte.";

        return {
          reply: safeReply,
          detected_language: parsed.detected_language || 'fr',
          intent: parsed.intent || 'info',
          next_action: parsed.next_action || 'waiting_verification',
        };

      } catch (err: any) {
        const msg = `[${model}] ${err.message}`;
        errors.push(msg);

        if (err.status === 401 || err.status === 403) break;

        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  throw new Error(`Gemini error:\n${errors.join('\n')}`);
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
