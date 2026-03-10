// supabase/functions/_shared/memory.ts
// ════════════════════════════════════════════════════════════
// MÉMOIRE IA v6.0
// ════════════════════════════════════════════════════════════
//
// NOUVEAUTÉS vs v5.0 :
//
// [FIX 1] ISOLATION PAGES — getRecentHistory prend maintenant
//   pageId en paramètre et filtre par (sender_psid, page_id).
//   En production Facebook les PSIDs sont page-scoped, donc
//   la confusion était théoriquement impossible. Mais en test
//   admin (même compte sur 2 pages) le risque était réel.
//   La signature change : getRecentHistory(senderId, pageId).
//
// [FIX 2] PURGE AUTOMATIQUE INTELLIGENTE — saveToHistory
//   déclenche une purge fire-and-forget en 2 passes après
//   chaque insertion :
//     PASSE 1 — Temporelle : supprime les messages > 48h
//     PASSE 2 — Quantitative : garde les 20 derniers max
//   La purge ne bloque jamais la réponse à l'utilisateur.
//
// [STABLE] Résumé IA tous les 10 messages (inchangé v5.0).
// [STABLE] Format interne { role, content } partout.
// [STABLE] buildPayload dans gemini.ts est le seul endroit
//   qui convertit vers le format Gemini natif { parts[] }.
// ════════════════════════════════════════════════════════════

import { supabase } from './db.ts';

function getSummaryApiKey(): string {
  return (Deno.env.get('GEMINI_API_KEY') ?? '').split(',')[0].trim();
}

const SUMMARIZE_EVERY  = 10;  // résumé tous les N messages
const MAX_HISTORY_ROWS = 20;  // max lignes conservées par user/page
const HISTORY_TTL_H    = 48;  // purge les messages > 48 heures

// ════════════════════════════════════════════════════════════
// getOrCreateMemory
// ════════════════════════════════════════════════════════════
export async function getOrCreateMemory(senderId: string, pageId: string) {
  const { data, error } = await supabase
    .from('ai_memory')
    .select('*')
    .eq('sender_psid', senderId)
    .eq('page_id', pageId)
    .maybeSingle();

  if (error) console.error('❌ getOrCreateMemory:', error.message);

  if (!data) {
    const { data: created, error: insertErr } = await supabase
      .from('ai_memory')
      .insert({
        sender_psid:       senderId,
        page_id:           pageId,
        summary:           '',
        interaction_count: 0,
      })
      .select()
      .single();

    if (insertErr) console.error('❌ ai_memory insert:', insertErr.message);
    return created;
  }
  return data;
}

// ════════════════════════════════════════════════════════════
// updateMemoryAfterMessage — incrémente + résumé si besoin
// ════════════════════════════════════════════════════════════
export async function updateMemoryAfterMessage(
  senderId: string,
  pageId: string,
  memory: Record<string, unknown>,
): Promise<void> {
  const newCount = (memory.interaction_count as number || 0) + 1;

  await supabase
    .from('ai_memory')
    .update({ interaction_count: newCount })
    .eq('sender_psid', senderId)
    .eq('page_id', pageId);

  // Résumé fire-and-forget tous les SUMMARIZE_EVERY messages
  if (newCount % SUMMARIZE_EVERY === 0) {
    summarizeMemory(senderId, pageId, memory).catch(err =>
      console.error('❌ summarizeMemory async:', err),
    );
  }
}

// ════════════════════════════════════════════════════════════
// summarizeMemory — Résumé intelligent par Gemini 1.5 flash
// ════════════════════════════════════════════════════════════
async function summarizeMemory(
  senderId: string,
  pageId: string,
  currentMemory: Record<string, unknown>,
): Promise<void> {
  const apiKey = getSummaryApiKey();
  if (!apiKey) return;

  try {
    const { data: history } = await supabase
      .from('conversation_history')
      .select('role, content, created_at')
      .eq('sender_psid', senderId)
      .eq('page_id', pageId)           // isolé par page
      .order('created_at', { ascending: true })
      .limit(30);

    if (!history?.length) return;

    const histText = history
      .map(m => `${m.role === 'user' ? 'User' : 'Tsanta'}: ${m.content}`)
      .join('\n');

    const currentSummary  = (currentMemory.summary as string) || 'Aucun résumé précédent.';
    const booksPurchased  = (currentMemory.books_purchased as string[]) || [];

    const prompt = `Tu es le système de mémoire de TSANTA, conseiller commercial de TeacherMada.

RÉSUMÉ PRÉCÉDENT :
${currentSummary}

ACHATS CONNUS : ${booksPurchased.join(', ') || 'Aucun'}

CONVERSATION RÉCENTE :
${histText}

Génère un résumé STRUCTURÉ (200 mots max) couvrant :
1. Profil : prénom (si mentionné), langue(s) ciblée(s), niveau, ville/région
2. Motivation principale et cas d'usage (travail, études, voyages, passion)
3. Stade tunnel de vente (prospect froid / intéressé / chaud / client)
4. Objections exprimées et arguments qui ont fonctionné ou non
5. Solutions TeacherMada présentées et réaction de l'utilisateur
6. Prochaine action recommandée pour TSANTA
7. Informations utiles : emploi, projets, contraintes temps/budget

Réponds UNIQUEMENT avec le résumé structuré, sans introduction.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.3 },
      }),
    });

    const result     = await res.json();
    const newSummary = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!newSummary) return;

    // Récupérer les titres de livres achetés
    const { data: sales } = await supabase
      .from('sales')
      .select('books(title)')
      .eq('sender_psid', senderId);

    const titles = (sales ?? [])
      .map((s: any) => s.books?.title)
      .filter(Boolean) as string[];

    await supabase
      .from('ai_memory')
      .update({
        summary:             newSummary,
        books_purchased:     titles.length ? titles : booksPurchased,
        last_summarized_at:  new Date().toISOString(),
      })
      .eq('sender_psid', senderId)
      .eq('page_id', pageId);

    console.log(`✅ Mémoire résumée [page:${pageId.slice(-4)} user:${senderId.slice(-6)}] ${newSummary.length} chars`);
  } catch (err) {
    console.error('❌ summarizeMemory:', err);
  }
}

// ════════════════════════════════════════════════════════════
// getRecentHistory — v6.0 : filtre par (sender_psid, page_id)
// ════════════════════════════════════════════════════════════
//
// CHANGEMENT DE SIGNATURE vs v5.0 :
//   v5.0 : getRecentHistory(senderId)
//   v6.0 : getRecentHistory(senderId, pageId)  ← pageId ajouté
//
// Le webhook/index.ts doit passer pageId à cet appel.
// Voir processMessage() dans webhook/index.ts v6.0.
//
export async function getRecentHistory(
  senderId: string,
  pageId: string,   // ← nouveau paramètre v6.0
): Promise<Array<{ role: string; content: string }>> {
  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, content')
    .eq('sender_psid', senderId)
    .eq('page_id', pageId)             // ← isolation par page
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('❌ getRecentHistory:', error.message);
    return [];
  }
  if (!data?.length) return [];

  return data
    .reverse()
    .map(m => ({
      role:    m.role === 'user' ? 'user' : 'assistant',
      content: (m.content ?? '').trim(),
    }))
    .filter(m => m.content.length > 0);
}

// ════════════════════════════════════════════════════════════
// saveToHistory — Insertion + purge intelligente automatique
// ════════════════════════════════════════════════════════════
//
// Après chaque insertion, déclenche purgeOldHistory() en
// arrière-plan (fire-and-forget) pour maintenir la table
// propre sans jamais bloquer la réponse à l'utilisateur.
//
export async function saveToHistory(
  senderId: string,
  pageId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const trimmed = content?.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from('conversation_history')
    .insert({ sender_psid: senderId, page_id: pageId, role, content: trimmed });

  if (error) {
    console.error('❌ saveToHistory insert:', error.message);
    return;
  }

  // Purge asynchrone — ne bloque pas
  purgeOldHistory(senderId, pageId).catch(err =>
    console.error('❌ purgeOldHistory async:', err),
  );
}

// ════════════════════════════════════════════════════════════
// purgeOldHistory — 2 passes de nettoyage
// ════════════════════════════════════════════════════════════
//
// PASSE 1 — Temporelle :
//   Supprime les messages créés il y a plus de HISTORY_TTL_H
//   heures pour cet utilisateur/page.
//
// PASSE 2 — Quantitative :
//   Si après la purge temporelle il reste encore plus de
//   MAX_HISTORY_ROWS messages, on garde uniquement les plus
//   récents. Protège contre les sessions de chat intensives.
//
async function purgeOldHistory(senderId: string, pageId: string): Promise<void> {
  try {
    // PASSE 1 : supprimer les messages trop anciens
    const cutoff = new Date(Date.now() - HISTORY_TTL_H * 3_600_000).toISOString();

    const { error: err1 } = await supabase
      .from('conversation_history')
      .delete()
      .eq('sender_psid', senderId)
      .eq('page_id', pageId)
      .lt('created_at', cutoff);

    if (err1) console.error('❌ purge temporelle:', err1.message);

    // PASSE 2 : garder seulement MAX_HISTORY_ROWS derniers
    const { data: recent } = await supabase
      .from('conversation_history')
      .select('id')
      .eq('sender_psid', senderId)
      .eq('page_id', pageId)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY_ROWS);

    if (!recent || recent.length < MAX_HISTORY_ROWS) return;

    const idsToKeep = recent.map(r => r.id);

    const { error: err2 } = await supabase
      .from('conversation_history')
      .delete()
      .eq('sender_psid', senderId)
      .eq('page_id', pageId)
      .not('id', 'in', `(${idsToKeep.join(',')})`);

    if (err2) console.error('❌ purge quantitative:', err2.message);
    else console.log(`🧹 Historique purgé [page:${pageId.slice(-4)} user:${senderId.slice(-6)}]`);

  } catch (err) {
    console.error('❌ purgeOldHistory:', err);
  }
}t
