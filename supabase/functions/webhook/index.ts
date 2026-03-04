// supabase/functions/webhook/index.ts
// ============================================================
// EDGE FUNCTION PRINCIPALE — Webhook Facebook Messenger
// Version corrigée : envoie uniquement le texte à Messenger
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

// ── Fonction utilitaire : parser proprement réponse IA ──────
function extractAIText(aiRaw: any): { text: string; meta: any } {
  let aiText = '';
  let aiMeta: any = null;

  try {
    const parsed = typeof aiRaw === 'string' ? JSON.parse(aiRaw) : aiRaw;

    if (typeof parsed === 'object' && parsed !== null) {
      aiText = parsed.text || JSON.stringify(parsed);
      aiMeta = parsed;
    } else {
      aiText = String(parsed);
    }
  } catch {
    aiText = String(aiRaw);
  }

  return { text: aiText, meta: aiMeta };
}

// ── Commandes admin ──────────────────────────────────────────
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

  await sendMessage(senderId, {
    text:
      '📋 Commandes admin :\n\n' +
      '@admin list → Voir les livres\n' +
      '@admin stats → Statistiques ventes'
  }, pageAccessToken);
}

// ── Traitement message entrant ───────────────────────────────
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

  try {
    // 1️⃣ Sauvegarde message user
    await saveToHistory(senderId, pageId, 'user', messageText);

    // 2️⃣ Charger mémoire + historique
    const [memory, history] = await Promise.all([
      getOrCreateMemory(senderId, pageId),
      getRecentHistory(senderId)
    ]);

    // 3️⃣ Appel IA
    const aiRaw = await callGemini(
      messageText,
      history,
      memory?.summary || ''
    );

    // 4️⃣ Extraction texte propre
    const { text: aiText } = extractAIText(aiRaw);

    // 5️⃣ Sauvegarde réponse texte uniquement
    await saveToHistory(senderId, pageId, 'assistant', aiText);

    // 6️⃣ Envoi texte propre à Messenger
    await sendMessage(senderId, { text: aiText }, pageAccessToken);

    // 7️⃣ Mise à jour mémoire
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

// ── Postback ────────────────────────────────────────────────
async function processPostback(
  event: Record<string, unknown>,
  pageAccessToken: string
): Promise<void> {
  const sender = event.sender as { id: string };
  const senderId = sender?.id;
  if (!senderId) return;

  await sendMessage(senderId, {
    text:
      '🤝 Tongasoa!\n\n' +
      '🤝 Bienvenue !\n\n' +
      'Envoyez un message ou votre code TM-XXXXXX.'
  }, pageAccessToken);
}

// ════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

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

  if (req.method === 'POST') {
    const body = await req.json();

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
