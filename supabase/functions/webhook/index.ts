// supabase/functions/webhook/index.ts
// ============================================================
// EDGE FUNCTION PRINCIPALE — Webhook Facebook Messenger
// Remplace complètement le serveur Express/Render
// ============================================================

import { supabase } from './_shared/db.ts';
import { sendMessage } from './_shared/messenger.ts';
import { callGemini } from './_shared/gemini.ts';
import { handlePromoCode, createPromoCode } from './_shared/promo.ts';
import {
  getOrCreateMemory,
  getRecentHistory,
  saveToHistory,
  updateMemoryAfterMessage
} from './_shared/memory.ts';

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
    text: '🤝 Tongasoa!\n\n🤝 Bienvenue !\n\nEnvoyez un message ou votre code TM-XXXXXX pour télécharger un livre. 😊'
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
