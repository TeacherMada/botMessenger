// supabase/functions/_shared/promo.ts
// Gestion des codes promo et liens de téléchargement signés

import { supabase } from './db.ts';
import { sendMessage } from './messenger.ts';

const BASE_URL = Deno.env.get('SUPABASE_URL')!;
const DOWNLOAD_FUNCTION_URL = `${Deno.env.get('EDGE_FUNCTION_BASE_URL')}/download`;

// ── Générer un lien signé Supabase Storage ───────────────────
export async function generateSignedDownloadUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase
    .storage
    .from('books')
    .createSignedUrl(storagePath, 3600); // Expire dans 1 heure

  if (error) {
    console.error('❌ generateSignedUrl error:', error.message);
    return null;
  }

  return data.signedUrl;
}

// ── Valider un code promo et envoyer le lien ─────────────────
export async function handlePromoCode(
  code: string,
  senderId: string,
  pageId: string,
  pageAccessToken: string
): Promise<boolean> {
  const upperCode = code.toUpperCase();

  // Chercher le promo dans Supabase
  const { data: promo, error } = await supabase
    .from('promos')
    .select('*, books(title, storage_path, price, currency)')
    .eq('code', upperCode)
    .single();

  if (error || !promo) {
    await sendMessage(senderId, { text: '❌ Code invalide. Verifie le code et réessaie.' }, pageAccessToken);
    return false;
  }

  if (promo.used) {
    await sendMessage(senderId, { text: '❌ Ce code a déjà été utilisé.' }, pageAccessToken);
    return false;
  }

  if (new Date() > new Date(promo.expires_at)) {
    await sendMessage(senderId, { text: '❌ Ce code est expiré. Contacte un admin pour en obtenir un nouveau.' }, pageAccessToken);
    return false;
  }

  // Générer un token de téléchargement unique
  const downloadToken = crypto.randomUUID() + '-' + Date.now();

  // Marquer le promo comme utilisé
  await supabase
    .from('promos')
    .update({ used: true, download_token: downloadToken })
    .eq('id', promo.id);

  // Enregistrer la vente
  await supabase
    .from('sales')
    .insert({
      promo_id: promo.id,
      book_id: promo.book_id,
      sender_psid: senderId,
      page_id: pageId,
      amount: promo.books?.price || 0,
      currency: promo.books?.currency || 'MGA'
    });

  // Construire le lien de téléchargement
  const downloadLink = `${DOWNLOAD_FUNCTION_URL}?token=${downloadToken}`;

  await sendMessage(senderId, {
    text:
      `✅ Code valide ! Merci pour ton achat.\n\n` +
      `📗 *${promo.books?.title}*\n\n` +
      `📥 Télécharge ton livre ici :\n${downloadLink}\n\n` +
      `⚠️ Lien valable 1 heure, usage unique.`
  }, pageAccessToken);

  return true;
}

// ── Créer un code promo (admin) ──────────────────────────────
export async function createPromoCode(bookId: string, createdBy: string): Promise<{ code: string; expiresAt: string } | null> {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const code = 'TM-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('promos')
    .insert({ code, book_id: bookId, expires_at: expiresAt, created_by: createdBy })
    .select()
    .single();

  if (error) {
    console.error('❌ createPromoCode:', error.message);
    return null;
  }

  return { code: data.code, expiresAt: data.expires_at };
}
