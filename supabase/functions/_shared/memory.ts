// supabase/functions/_shared/memory.ts
// ============================================================
// STRATÉGIE MÉMOIRE IA INTELLIGENTE
// ============================================================
//
// NIVEAU 1 — conversation_history (éphémère, 24h max, 20 messages)
//   → Contexte immédiat pour Gemini
//
// NIVEAU 2 — ai_memory (permanent, résumé intelligent)
//   → Qui est l'utilisateur, ses préférences, ses achats
//   → Mis à jour tous les 10 messages via Gemini
//
// STRATÉGIE DE RÉSUMÉ :
//   Gemini reçoit l'historique + le résumé précédent et produit
//   un nouveau résumé enrichi. Le résumé est injecté dans chaque
//   prompt pour donner à l'IA une "mémoire longue" sans stocker
//   tout l'historique.
// ============================================================

import { supabase } from './db.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const SUMMARIZE_EVERY = 10; // Résumer tous les 10 messages

// ── Récupérer ou créer la mémoire d'un utilisateur ──────────
export async function getOrCreateMemory(senderId: string, pageId: string) {
  const { data, error } = await supabase
    .from('ai_memory')
    .select('*')
    .eq('sender_psid', senderId)
    .eq('page_id', pageId)
    .maybeSingle();

  if (error) console.error('❌ getOrCreateMemory:', error.message);

  if (!data) {
    const { data: newMemory } = await supabase
      .from('ai_memory')
      .insert({ sender_psid: senderId, page_id: pageId, summary: '', interaction_count: 0 })
      .select()
      .single();
    return newMemory;
  }

  return data;
}

// ── Incrémenter le compteur et déclencher le résumé si besoin ─
export async function updateMemoryAfterMessage(
  senderId: string,
  pageId: string,
  memory: Record<string, unknown>
): Promise<void> {
  const newCount = (memory.interaction_count as number) + 1;

  await supabase
    .from('ai_memory')
    .update({ interaction_count: newCount })
    .eq('sender_psid', senderId)
    .eq('page_id', pageId);

  // Déclencher le résumé tous les SUMMARIZE_EVERY messages
  if (newCount % SUMMARIZE_EVERY === 0) {
    await summarizeMemory(senderId, pageId, memory);
  }
}

// ── Générer un résumé intelligent avec Gemini ───────────────
async function summarizeMemory(
  senderId: string,
  pageId: string,
  currentMemory: Record<string, unknown>
): Promise<void> {
  try {
    // Récupérer l'historique récent
    const { data: history } = await supabase
      .from('conversation_history')
      .select('role, content, created_at')
      .eq('sender_psid', senderId)
      .order('created_at', { ascending: true })
      .limit(20);

    if (!history?.length) return;

    const historyText = history
      .map(m => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const currentSummary = (currentMemory.summary as string) || 'Aucun résumé précédent.';
    const booksPurchased = (currentMemory.books_purchased as string[]) || [];

    const prompt = `Tu es un système de mémoire pour un chatbot éducatif malgache (TeacherMada).

RÉSUMÉ PRÉCÉDENT DE L'UTILISATEUR :
${currentSummary}

LIVRES DÉJÀ ACHETÉS : ${booksPurchased.join(', ') || 'Aucun'}

NOUVELLES CONVERSATIONS RÉCENTES :
${historyText}

Génère un résumé concis et structuré (max 200 mots) de ce que tu sais sur cet utilisateur. Inclus :
- Niveau scolaire / matières d'intérêt
- Langue préférée (malgache / français)
- Comportement d'achat et livres achetés
- Sujets récurrents ou besoins identifiés
- Ton utilisé dans les échanges

Réponds UNIQUEMENT avec le résumé, sans introduction ni explication.`;

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
      })
    });

    const result = await response.json();
    const newSummary = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!newSummary) return;

    // Extraire les livres achetés des ventes
    const { data: purchasedBooks } = await supabase
      .from('sales')
      .select('books(title)')
      .eq('sender_psid', senderId);

    const titles = purchasedBooks
      ?.map((s: { books?: { title?: string } }) => s.books?.title)
      .filter(Boolean) as string[];

    await supabase
      .from('ai_memory')
      .update({
        summary: newSummary,
        books_purchased: titles || booksPurchased,
        last_summarized_at: new Date().toISOString()
      })
      .eq('sender_psid', senderId)
      .eq('page_id', pageId);

    console.log(`✅ Mémoire résumée pour ${senderId}`);
  } catch (err) {
    console.error('❌ summarizeMemory error:', err);
  }
}

// ── Récupérer l'historique récent formaté pour Gemini ────────
export async function getRecentHistory(senderId: string): Promise<Array<{ role: string; parts: Array<{ text: string }> }>> {
  const { data } = await supabase
    .from('conversation_history')
    .select('role, content')
    .eq('sender_psid', senderId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!data?.length) return [];

  return data
    .reverse()
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));
}

// ── Sauvegarder un message dans l'historique ─────────────────
export async function saveToHistory(
  senderId: string,
  pageId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const { error } = await supabase
    .from('conversation_history')
    .insert({ sender_psid: senderId, page_id: pageId, role, content });

  if (error) console.error('❌ saveToHistory:', error.message);
}
