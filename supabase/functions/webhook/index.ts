// supabase/functions/_shared/db.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);
// fin db.ts

// supabase/functions/_shared/messenger.ts

export async function sendMessage(
  recipientId: string,
  message: Record<string, unknown>,
  pageAccessToken: string
): Promise<void> {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;

  const body = {
    recipient: { id: recipientId },
    message,
    messaging_type: 'RESPONSE',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`❌ sendMessage failed (${res.status}):`, err);
  }
} //fin Messenger.ts
// supabase/functions/_shared/gemini.ts

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `Tu es Tsanta, une assistante commerciale chaleureuse et professionnelle.
Tu aides les clients à découvrir et acheter des livres numériques.
Tu parles en français ou en malgache selon le client.
Sois concise, amicale et toujours orientée vers la vente.`;

export async function callGemini(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  memorySummary: string
): Promise<string> {
  // Construire le contexte avec la mémoire
  const systemWithMemory = memorySummary
    ? `${SYSTEM_PROMPT}\n\nContexte mémorisé sur ce client :\n${memorySummary}`
    : SYSTEM_PROMPT;

  // Convertir l'historique au format Gemini
  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  // Ajouter le message actuel
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemWithMemory }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 500,
    },
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('❌ Gemini error:', err);
    throw new Error(`Gemini HTTP ${res.status}`);
  }

  const data = await res.json();

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Réponse Gemini vide');

  return text.trim();
} //fin gemini.ts

// supabase/functions/_shared/memory.ts
import { supabase } from './db.ts';

const MAX_HISTORY = 20;       // messages récents envoyés à Gemini
const SUMMARY_THRESHOLD = 30; // résumer après X messages

// ── Historique récent ─────────────────────────────────────────
export async function getRecentHistory(
  senderId: string
): Promise<Array<{ role: string; content: string }>> {
  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, content')
    .eq('sender_id', senderId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);

  if (error) {
    console.error('❌ getRecentHistory:', error.message);
    return [];
  }

  // Retourner dans l'ordre chronologique
  return (data ?? []).reverse();
}

// ── Sauvegarder un message ────────────────────────────────────
export async function saveToHistory(
  senderId: string,
  pageId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const { error } = await supabase
    .from('conversation_history')
    .insert({ sender_id: senderId, page_id: pageId, role, content });

  if (error) console.error('❌ saveToHistory:', error.message);
}

// ── Mémoire persistante (résumé) ─────────────────────────────
export async function getOrCreateMemory(
  senderId: string,
  pageId: string
): Promise<{ id: string; summary: string; message_count: number } | null> {
  const { data, error } = await supabase
    .from('user_memory')
    .select('id, summary, message_count')
    .eq('sender_id', senderId)
    .eq('page_id', pageId)
    .maybeSingle();

  if (error) {
    console.error('❌ getOrCreateMemory:', error.message);
    return null;
  }

  if (data) return data;

  // Créer une entrée vierge
  const { data: created, error: createErr } = await supabase
    .from('user_memory')
    .insert({ sender_id: senderId, page_id: pageId, summary: '', message_count: 0 })
    .select('id, summary, message_count')
    .single();

  if (createErr) {
    console.error('❌ createMemory:', createErr.message);
    return null;
  }

  return created;
}

// ── Mettre à jour la mémoire après un échange ────────────────
export async function updateMemoryAfterMessage(
  senderId: string,
  pageId: string,
  memory: { id: string; summary: string; message_count: number }
): Promise<void> {
  const newCount = (memory.message_count ?? 0) + 1;

  // Résumer si on dépasse le seuil
  if (newCount % SUMMARY_THRESHOLD === 0) {
    const history = await getRecentHistory(senderId);
    const newSummary = await summarizeHistory(history, memory.summary);

    await supabase
      .from('user_memory')
      .update({ summary: newSummary, message_count: newCount, updated_at: new Date().toISOString() })
      .eq('id', memory.id);
  } else {
    await supabase
      .from('user_memory')
      .update({ message_count: newCount, updated_at: new Date().toISOString() })
      .eq('id', memory.id);
  }
}

// ── Résumer l'historique via Gemini ──────────────────────────
async function summarizeHistory(
  history: Array<{ role: string; content: string }>,
  existingSummary: string
): Promise<string> {
  const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');

  const prompt = existingSummary
    ? `Résumé existant :\n${existingSummary}\n\nNouvelle conversation :\n${historyText}\n\nFais un résumé court (max 200 mots) de ce que tu sais sur ce client (préférences, achats, questions, nom si mentionné).`
    : `Conversation :\n${historyText}\n\nFais un résumé court (max 200 mots) de ce que tu sais sur ce client.`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) return existingSummary;

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? existingSummary;
} //fin memory

// supabase/functions/_shared/promo.ts
import { supabase } from './db.ts';
import { sendMessage } from './messenger.ts';

// ── Créer un code promo (usage unique, 24h) ───────────────────
export async function createPromoCode(
  bookId: string,
  createdBy: string
): Promise<{ code: string; expiresAt: string } | null> {
  const code = 'TM-' + Math.random().toString(16).slice(2, 8).toUpperCase();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('promo_codes')
    .insert({
      code,
      book_id: bookId,
      created_by: createdBy,
      expires_at: expiresAt,
      is_used: false,
    });

  if (error) {
    console.error('❌ createPromoCode:', error.message);
    return null;
  }

  return { code, expiresAt };
}

// ── Valider et utiliser un code promo ─────────────────────────
export async function handlePromoCode(
  code: string,
  senderId: string,
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const normalizedCode = code.toUpperCase();

  // 1. Chercher le code
  const { data: promo, error } = await supabase
    .from('promo_codes')
    .select('id, book_id, is_used, expires_at, books(title, file_url, description)')
    .eq('code', normalizedCode)
    .maybeSingle();

  if (error || !promo) {
    await sendMessage(senderId, {
      text: `❌ Code "${normalizedCode}" introuvable. Vérifiez l'orthographe.`
    }, pageAccessToken);
    return;
  }

  // 2. Vérifier si déjà utilisé
  if (promo.is_used) {
    await sendMessage(senderId, {
      text: `⚠️ Ce code a déjà été utilisé. Chaque code est à usage unique.`
    }, pageAccessToken);
    return;
  }

  // 3. Vérifier l'expiration
  if (new Date(promo.expires_at) < new Date()) {
    await sendMessage(senderId, {
      text: `⏰ Ce code a expiré. Contactez-nous pour en obtenir un nouveau.`
    }, pageAccessToken);
    return;
  }

  // 4. Marquer comme utilisé
  const { error: updateErr } = await supabase
    .from('promo_codes')
    .update({
      is_used: true,
      used_by: senderId,
      used_at: new Date().toISOString(),
    })
    .eq('id', promo.id);

  if (updateErr) {
    console.error('❌ handlePromoCode update:', updateErr.message);
    await sendMessage(senderId, {
      text: '❌ Erreur lors de la validation. Réessayez.'
    }, pageAccessToken);
    return;
  }

  // 5. Enregistrer la vente
  await supabase.from('sales').insert({
    book_id: promo.book_id,
    buyer_id: senderId,
    page_id: pageId,
    promo_code_id: promo.id,
  });

  // 6. Envoyer le lien de téléchargement
  const book = promo.books as unknown as { title: string; file_url: string; description: string };

  await sendMessage(senderId, {
    text:
      `✅ Code validé ! Voici votre livre :\n\n` +
      `📗 *${book.title}*\n\n` +
      `📥 Téléchargez ici :\n${book.file_url}\n\n` +
      `Bonne lecture ! 😊`
  }, pageAccessToken);
} //fin promo
// supabase/functions/webhook/index.ts
// ============================================================
// EDGE FUNCTION PRINCIPALE — Webhook Facebook Messenger
// Remplace complètement le serveur Express/Render
// ============================================================

//import { supabase } from '../_shared/db.ts';
//import { sendMessage } from '../_shared/messenger.ts';
//import { callGemini } from '../_shared/gemini.ts';
//import { handlePromoCode, createPromoCode } from '../_shared/promo.ts';
//import {
  //getOrCreateMemory,
 // getRecentHistory,
  //saveToHistory,
 // updateMemoryAfterMessage
//} from '../_shared/memory.ts';

const VERIFY_TOKEN = Deno.env.get('VERIFY_TOKEN')!;
const PREFIX = '@';

// ── Récupérer le token d'une page depuis Supabase ────────────
async function getPageToken(pageId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('pages')
    .select('access_token')
    .eq('page_id', pageId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    console.error(`❌ No token for page ${pageId}:`, error?.message);
    return null;
  }
  return data.access_token;
}

// ── Commandes admin disponibles ──────────────────────────────
async function handleAdminCommand(
  senderId: string,
  args: string[],
  pageAccessToken: string
): Promise<void> {
  const ADMIN_IDS = (Deno.env.get('ADMIN_IDS') || '').split(',').map(s => s.trim());

  if (!ADMIN_IDS.includes(senderId)) {
    await sendMessage(senderId, { text: '❌ Accès refusé.' }, pageAccessToken);
    return;
  }

  const subCmd = args[0]?.toLowerCase();

  // @admin list — Voir les livres
  if (subCmd === 'list') {
    const { data: books } = await supabase
      .from('books')
      .select('id, title, price, currency, is_active')
      .order('created_at', { ascending: false });

    if (!books?.length) {
      return sendMessage(senderId, { text: '📂 Aucun livre dans la base.' }, pageAccessToken);
    }

    const list = books.map(b =>
      `${b.is_active ? '✅' : '❌'} [${b.id.slice(0, 8)}] ${b.title} — ${b.price} ${b.currency}`
    ).join('\n');

    return sendMessage(senderId, { text: `📚 Livres :\n\n${list}` }, pageAccessToken);
  }

  // @admin promo <book_id_court> — Créer un code promo
  if (subCmd === 'promo' && args[1]) {
    const shortId = args[1];

    // Chercher le livre par ID partiel
    const { data: books } = await supabase
      .from('books')
      .select('id, title')
      .ilike('id::text', `${shortId}%`);

    if (!books?.length) {
      return sendMessage(senderId, { text: `❌ Aucun livre trouvé avec l'ID "${shortId}"` }, pageAccessToken);
    }

    const book = books[0];
    const result = await createPromoCode(book.id, senderId);

    if (!result) {
      return sendMessage(senderId, { text: '❌ Erreur lors de la création du code.' }, pageAccessToken);
    }

    return sendMessage(senderId, {
      text:
        `✅ Code promo créé pour "${book.title}" :\n\n` +
        `🎟️  ${result.code}\n\n` +
        `⏰ Valable jusqu'au : ${new Date(result.expiresAt).toLocaleString('fr-MG')}\n` +
        `⚠️ Usage unique — 24 heures`
    }, pageAccessToken);
  }

  // @admin stats — Statistiques ventes
  if (subCmd === 'stats') {
    const { data: stats } = await supabase
      .from('sales_stats')
      .select('*')
      .order('total_sales', { ascending: false });

    if (!stats?.length) {
      return sendMessage(senderId, { text: '📊 Aucune vente enregistrée.' }, pageAccessToken);
    }

    const statsText = stats.map(s =>
      `📗 ${s.title}\n   Ventes: ${s.total_sales} | Revenus: ${s.total_revenue} MGA`
    ).join('\n\n');

    return sendMessage(senderId, { text: `📊 Statistiques :\n\n${statsText}` }, pageAccessToken);
  }

  // Aide admin
  await sendMessage(senderId, {
    text:
      '📋 Commandes admin :\n\n' +
      '@admin list → Voir les livres\n' +
      '@admin promo <id> → Créer code promo\n' +
      '@admin stats → Statistiques ventes'
  }, pageAccessToken);
}

// ── Handler d'un message entrant ─────────────────────────────
async function processMessage(
  event: Record<string, unknown>,
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const sender = event.sender as { id: string };
  const senderId = sender?.id;
  if (!senderId) return;

  const message = event.message as Record<string, unknown>;
  const messageText = (message?.text as string)?.trim();
  if (!messageText) return;

  // ── Détection code promo (TM-XXXXXX) ──────────────────────
  const promoMatch = messageText.match(/\bTM-[A-F0-9]{6}\b/i);
  if (promoMatch) {
    await handlePromoCode(promoMatch[0], senderId, pageId, pageAccessToken);
    return;
  }

  // ── Commandes avec préfixe @ ───────────────────────────────
  if (messageText.startsWith(PREFIX)) {
    const parts = messageText.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = parts.shift()?.toLowerCase();

    if (cmd === 'admin') {
      await handleAdminCommand(senderId, parts, pageAccessToken);
      return;
    }

    if (cmd === 'help') {
      await sendMessage(senderId, {
        text: '📋 Commandes disponibles :\n\n@help — Cette aide\n\nEnvoyez un message pour parler avec Tsanta !\nEnvoyez votre code TM-XXXXXX pour télécharger un livre.'
      }, pageAccessToken);
      return;
    }

    await sendMessage(senderId, { text: `❌ Commande inconnue : @${cmd}` }, pageAccessToken);
    return;
  }

  // ── Agent IA Gemini (tsanta) ───────────────────────────────
  try {
    // 1. Sauvegarder le message utilisateur
    await saveToHistory(senderId, pageId, 'user', messageText);

    // 2. Charger la mémoire et l'historique
    const [memory, history] = await Promise.all([
      getOrCreateMemory(senderId, pageId),
      getRecentHistory(senderId)
    ]);

    // 3. Appel Gemini avec contexte enrichi
    const aiResponse = await callGemini(
      messageText,
      history,
      memory?.summary || ''
    );

    // 4. Sauvegarder la réponse
    await saveToHistory(senderId, pageId, 'assistant', aiResponse);

    // 5. Envoyer la réponse
    await sendMessage(senderId, { text: aiResponse }, pageAccessToken);

    // 6. Mettre à jour la mémoire (résumé si nécessaire)
    if (memory) {
      await updateMemoryAfterMessage(senderId, pageId, memory);
    }
  } catch (err) {
    console.error('❌ processMessage error:', err);
    await sendMessage(senderId, {
      text: '❌ Erreur système. Réessayez dans un instant.'
    }, pageAccessToken);
  }
}

// ── Handler postback ──────────────────────────────────────────
async function processPostback(
  event: Record<string, unknown>,
  pageAccessToken: string
): Promise<void> {
  const sender = event.sender as { id: string };
  const senderId = sender?.id;
  if (!senderId) return;

  const postback = event.postback as { payload: string };

  await sendMessage(senderId, {
    text: '🤝 Tongasoa!\n\n🤝 Bienvenue !\n\nEnvoyez un message à Tsanta ou votre code TM-XXXXXX pour télécharger un livre. 😊'
  }, pageAccessToken);
}

// ════════════════════════════════════════════════════════════
// EDGE FUNCTION ENTRY POINT
// ════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── Vérification webhook Facebook ────────────────────────
  if (req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verified');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ── Traitement des événements Messenger ──────────────────
  if (req.method === 'POST') {
    // Répondre immédiatement à Facebook (requis < 5s)
    const body = await req.json();

    // Traitement asynchrone en arrière-plan
    EdgeRuntime.waitUntil((async () => {
      if (body.object !== 'page') return;

      for (const entry of body.entry || []) {
        const pageId = entry.id as string;
        const pageToken = await getPageToken(pageId);

        if (!pageToken) continue;

        for (const event of entry.messaging || []) {
          if (event.message)  await processMessage(event, pageId, pageToken);
          if (event.postback) await processPostback(event, pageToken);
        }
      }
    })());

    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  return new Response('Method Not Allowed', { status: 405 });
});
