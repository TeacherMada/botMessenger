// supabase/functions/_shared/gemini.ts
// ============================================================
// AGENT GEMINI — TeacherMada
// Connait le catalogue de livres et peut recommander/vendre
// ============================================================

import { supabase } from './db.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ── Charger le catalogue pour l'IA ───────────────────────────
async function getBooksForAI(): Promise<string> {
  const { data, error } = await supabase
    .from('books_catalog')         // Vue RLS sécurisée (sans storage_path)
    .select('title, description, subject, level, price, currency');

  if (error || !data?.length) return 'Aucun livre disponible actuellement.';

  return data.map(b =>
    `📗 "${b.title}" (${b.subject}, ${b.level}) — ${b.price} ${b.currency}\n   ${b.description}`
  ).join('\n\n');
}

// ── Prompt système de l'agent TeacherMada ────────────────────
function buildSystemPrompt(booksCatalog: string, memoryContext: string): string {
  return `Tu es Tsanta, l'assistant intelligent de TeacherMada — une plateforme éducative malgache.

TON RÔLE :
- Aider les étudiants malgaches dans leurs études
- Répondre en malgache ou français selon la langue de l'utilisateur
- Recommander les livres du catalogue quand c'est pertinent
- Expliquer comment acheter un livre (code promo)

CATALOGUE DES LIVRES DISPONIBLES :
${booksCatalog}

COMMENT ACHETER UN LIVRE :
1. L'utilisateur contacte un admin TeacherMada pour payer
2. L'admin génère un code promo (format TM-XXXXXX)
3. L'utilisateur envoie ce code dans ce chat
4. Un lien de téléchargement temporaire est envoyé automatiquement

CE QUE TU SAIS SUR CET UTILISATEUR :
${memoryContext || 'Nouvel utilisateur, aucun historique.'}

RÈGLES :
- Réponses courtes et directes (max 3 paragraphes)
- Toujours bienveillant et encourageant
- Ne jamais inventer des livres qui ne sont pas dans le catalogue
- Si tu recommandes un livre, mentionne son prix et comment l'obtenir
- Ne jamais partager de liens de téléchargement directs (c'est géré automatiquement)`;
}

// ── Appel principal à Gemini ──────────────────────────────────
export async function callGemini(
  userMessage: string,
  history: Array<{ role: string; parts: Array<{ text: string }> }>,
  memoryContext: string
): Promise<string> {
  try {
    const booksCatalog = await getBooksForAI();
    const systemPrompt = buildSystemPrompt(booksCatalog, memoryContext);

    // Construire la conversation pour Gemini
    const contents = [
      // Message système en premier (role user simulé)
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Compris ! Je suis Tsanta, prêt à aider.' }] },
      // Historique récent
      ...history,
      // Message actuel
      { role: 'user', parts: [{ text: userMessage }] }
    ];

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.7,
          topP: 0.9
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('❌ Gemini API error:', err);
      return "⚠️ Tsy azo nandray valiny. Andao mamerina ny fanontaniana.";
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

    return text || "⚠️ Tsy nahazo valiny mazava. Mamerina azafady.";
  } catch (err) {
    console.error('❌ callGemini error:', err);
    return "❌ Erreur système. Réessayez dans un instant.";
  }
}
