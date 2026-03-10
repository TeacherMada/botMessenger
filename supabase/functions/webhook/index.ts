// supabase/functions/webhook/index.ts
// ════════════════════════════════════════════════════════════
// WEBHOOK MESSENGER v6.0
// ════════════════════════════════════════════════════════════
//
// CHANGEMENT vs v5.0 :
//   getRecentHistory() reçoit maintenant pageId en 2e paramètre
//   pour correspondre à la nouvelle signature de memory.ts v6.0.
//   C'est le seul changement fonctionnel dans ce fichier.
//
// PIPELINE COMPLET (inchangé) :
//   callGemini() → safeExtract() → saveToHistory()
//   → formatAndSplit() → sendMessage() × N (délai 400ms)
// ════════════════════════════════════════════════════════════

import { supabase }                          from './_shared/db.ts';
import { sendMessage }                       from './_shared/messenger.ts';
import { callGemini, extractTextFromAny }    from './_shared/gemini.ts';
import { handlePromoCode }                   from './_shared/promo.ts';
import { formatAndSplit }                    from './_shared/formatter.ts';
import {
  getOrCreateMemory,
  getRecentHistory,
  saveToHistory,
  updateMemoryAfterMessage,
} from './_shared/memory.ts';

const VERIFY_TOKEN = Deno.env.get('VERIFY_TOKEN')!;

// ════════════════════════════════════════════════════════════
// CACHE MULTI-PAGES — TTL 5 minutes
// ════════════════════════════════════════════════════════════
interface PageCache { token: string; cachedAt: number; }
const pageCache = new Map<string, PageCache>();
const PAGE_TTL  = 5 * 60 * 1000;

async function getPageToken(pageId: string): Promise<string | null> {
  const now    = Date.now();
  const cached = pageCache.get(pageId);
  if (cached && now - cached.cachedAt < PAGE_TTL) return cached.token;

  const { data, error } = await supabase
    .from('pages')
    .select('access_token')
    .eq('page_id', pageId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    console.error(`❌ Token page ${pageId}:`, error?.message);
    return null;
  }

  pageCache.set(pageId, { token: data.access_token, cachedAt: now });
  console.log(`🔑 Token page ${pageId.slice(-6)} mis en cache`);
  return data.access_token;
}

// ════════════════════════════════════════════════════════════
// safeExtract — Filet de sécurité final anti-JSON brut
// ════════════════════════════════════════════════════════════
function safeExtract(reply: string): string {
  const t = reply?.trim() ?? '';

  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const extracted = extractTextFromAny(JSON.parse(t));
      if (extracted) return extracted.trim();
    } catch { /* pas du JSON valide → garder tel quel */ }
  }

  return t
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

// ════════════════════════════════════════════════════════════
// sendFormattedMessage — Formatage + envoi séquentiel
// ════════════════════════════════════════════════════════════
async function sendFormattedMessage(
  senderId: string,
  text: string,
  token: string,
): Promise<void> {
  const chunks = formatAndSplit(text);
  if (!chunks.length) return;

  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(senderId, { text: chunks[i] }, token);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  if (chunks.length > 1) {
    console.log(`📤 ${chunks.length} morceaux → ${senderId.slice(-6)}`);
  }
}

// ════════════════════════════════════════════════════════════
// handleAdminCommand
// ════════════════════════════════════════════════════════════
async function handleAdminCommand(
  senderId: string,
  args: string[],
  token: string,
): Promise<void> {
  const ADMIN_IDS = (Deno.env.get('ADMIN_IDS') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!ADMIN_IDS.includes(senderId)) {
    await sendMessage(senderId, { text: '❌ Accès refusé.' }, token);
    return;
  }

  const cmd = args[0]?.toLowerCase();

  if (cmd === 'list') {
    const { data } = await supabase
      .from('books')
      .select('id, title, price, currency, is_active')
      .order('created_at', { ascending: false });

    if (!data?.length) {
      await sendMessage(senderId, { text: '📂 Aucun livre.' }, token);
      return;
    }
    const list = data
      .map(b => `${b.is_active ? '✅' : '❌'} [${b.id.slice(0, 8)}] ${b.title} — ${b.price} ${b.currency}`)
      .join('\n');
    await sendFormattedMessage(senderId, `📚 Livres :\n\n${list}`, token);
    return;
  }

  if (cmd === 'stats') {
    const { data } = await supabase
      .from('sales_stats')
      .select('*')
      .order('total_sales', { ascending: false });

    if (!data?.length) {
      await sendMessage(senderId, { text: '📊 Aucune vente.' }, token);
      return;
    }
    const txt = data
      .map(s => `📗 ${s.title}\n   Ventes: ${s.total_sales} | Revenus: ${s.total_revenue} MGA`)
      .join('\n\n');
    await sendFormattedMessage(senderId, `📊 Stats :\n\n${txt}`, token);
    return;
  }

  if (cmd === 'users') {
    const { count } = await supabase
      .from('ai_memory')
      .select('*', { count: 'exact', head: true });
    await sendMessage(senderId, { text: `👥 Utilisateurs : ${count ?? 0}` }, token);
    return;
  }

  await sendMessage(senderId, {
    text: '📋 Commandes admin :\n\n' +
      '@admin list  → Catalogue livres\n' +
      '@admin stats → Statistiques ventes\n' +
      '@admin users → Utilisateurs actifs',
  }, token);
}

// ════════════════════════════════════════════════════════════
// processMessage — Flux principal IA
// ════════════════════════════════════════════════════════════
async function processMessage(
  event: Record<string, unknown>,
  pageId: string,
  token: string,
): Promise<void> {
  const senderId    = (event.sender as { id?: string })?.id;
  if (!senderId) return;

  const messageText = ((event.message as Record<string, unknown>)?.text as string)?.trim();
  if (!messageText) return;

  console.log(`📨 [page:${pageId.slice(-6)} user:${senderId.slice(-6)}]: "${messageText.slice(0, 60)}"`);

  // ── Code promo TM-XXXXXX ────────────────────────────────
  if (/^TM-[A-F0-9]{6}$/i.test(messageText)) {
    await handlePromoCode(messageText, senderId, pageId, token);
    return;
  }

  // ── Commande admin ──────────────────────────────────────
  if (messageText.toLowerCase().startsWith('@admin')) {
    await handleAdminCommand(senderId, messageText.split(/\s+/).slice(1), token);
    return;
  }

  // ── Flux IA ─────────────────────────────────────────────
  try {
    // 1️⃣  Sauvegarder le message utilisateur
    await saveToHistory(senderId, pageId, 'user', messageText);

    // 2️⃣  Charger mémoire + historique en parallèle
    //     getRecentHistory reçoit pageId (v6.0)
    const [memory, history] = await Promise.all([
      getOrCreateMemory(senderId, pageId),
      getRecentHistory(senderId, pageId),   // ← v6.0 : pageId passé
    ]);

    // 3️⃣  Appel Gemini
    //     responseSchema garantit { reply, detected_language, intent, next_action }
    //     L'instruction système est chargée depuis instructions.ts (zéro latence)
    const aiResult = await callGemini(
      messageText,
      history,
      memory?.summary ?? '',
    );

    // 4️⃣  Extraction défensive finale
    const rawText = safeExtract(aiResult.reply);

    if (!rawText) {
      console.warn('⚠️ Réponse IA vide après extraction');
      await sendMessage(senderId, {
        text: 'Miala tsiny, avereno ny fanontaniana.\nVeuillez reformuler votre message.',
      }, token);
      return;
    }

    console.log(`🤖 [${aiResult.intent}/${aiResult.detected_language}] "${rawText.slice(0, 70)}"`);

    // 5️⃣  Stocker le texte pur dans l'historique (jamais le JSON)
    await saveToHistory(senderId, pageId, 'assistant', rawText);

    // 6️⃣  Formater et envoyer
    await sendFormattedMessage(senderId, rawText, token);

    // 7️⃣  Mise à jour mémoire long-terme
    if (memory) await updateMemoryAfterMessage(senderId, pageId, memory);

  } catch (err) {
    console.error('❌ processMessage:', err);
    await sendMessage(senderId, {
      text: '⚠️ Olana teknika kely. Avereno ny hafatrao iray minitra.\n' +
            'Problème technique. Réessayez dans une minute.',
    }, token);
  }
}

// ════════════════════════════════════════════════════════════
// processPostback — Get Started / quick_reply
// ════════════════════════════════════════════════════════════
async function processPostback(
  event: Record<string, unknown>,
  _pageId: string,
  token: string,
): Promise<void> {
  const senderId = (event.sender as { id?: string })?.id;
  if (!senderId) return;

  await sendMessage(senderId, {
    text: '🤝 Tongasoa eto amin\'ny TeacherMada!\n\n' +
          'Bienvenue chez TeacherMada ! 🎓\n\n' +
          'Mianatra teny vaovao, mametraha fanontaniana, na ' +
          'alefaso ny kaodim-promos TM-XXXXXX.\n\n' +
          'Apprenez une langue, posez vos questions, ou entrez ' +
          'votre code promo TM-XXXXXX.',
  }, token);
}

// ════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── Vérification webhook Facebook (GET) ─────────────────
  if (req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook vérifié');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ── Réception événements Messenger (POST) ───────────────
  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return new Response('Bad Request', { status: 400 }); }

    // ⚡ Répondre 200 à Facebook IMMÉDIATEMENT (< 5 s requis)
    EdgeRuntime.waitUntil(
      (async () => {
        if (body.object !== 'page') return;

        for (const entry of (body.entry as any[]) ?? []) {
          const pageId = entry.id as string;
          if (!pageId) continue;

          const pageToken = await getPageToken(pageId);
          if (!pageToken) {
            console.error(`⚠️ Page ${pageId} ignorée — token introuvable`);
            continue;
          }

          for (const event of (entry.messaging as any[]) ?? []) {
            try {
              if (event.message)  await processMessage(event, pageId, pageToken);
              if (event.postback) await processPostback(event, pageId, pageToken);
            } catch (err) {
              console.error(`❌ Event non traité [${pageId}]:`, err);
            }
          }
        }
      })(),
    );

    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  return new Response('Method Not Allowed', { status: 405 });
});
