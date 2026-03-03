// supabase/functions/download/index.ts
// ============================================================
// EDGE FUNCTION — Téléchargement PDF sécurisé
// Génère un lien signé Supabase Storage (1h) à usage unique
// ============================================================

import { supabase } from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url   = new URL(req.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return htmlResponse('❌ Token manquant', 400);
  }

  // ── Vérifier le token dans Supabase ──────────────────────
  const { data: promo, error } = await supabase
    .from('promos')
    .select('*, books(title, storage_path)')
    .eq('download_token', token)
    .single();

  if (error || !promo) {
    return htmlResponse('❌ Lien invalide ou déjà utilisé.', 404);
  }

  if (promo.token_used) {
    return htmlResponse('❌ Ce lien a déjà été utilisé. Chaque lien est valable une seule fois.', 403);
  }

  if (new Date() > new Date(promo.expires_at)) {
    return htmlResponse('❌ Lien expiré. Contacte un admin pour obtenir un nouveau code.', 410);
  }

  if (!promo.books?.storage_path) {
    return htmlResponse('❌ Fichier introuvable.', 404);
  }

  // ── Générer URL signée Supabase Storage (1 heure) ────────
  const { data: signedData, error: signError } = await supabase
    .storage
    .from('books')
    .createSignedUrl(promo.books.storage_path, 3600, {
      download: promo.books.title + '.pdf'  // Nom du fichier au téléchargement
    });

  if (signError || !signedData?.signedUrl) {
    console.error('❌ Signed URL error:', signError?.message);
    return htmlResponse('❌ Erreur lors de la génération du lien. Réessaie dans un instant.', 500);
  }

  // ── Marquer le token comme utilisé (usage unique) ────────
  await supabase
    .from('promos')
    .update({ token_used: true, download_token: null })
    .eq('id', promo.id);

  console.log(`📦 Download: "${promo.books.title}" (promo: ${promo.id})`);

  // ── Page de téléchargement élégante ──────────────────────
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Téléchargement — ${promo.books.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .card {
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 24px;
      padding: 48px 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 32px 64px rgba(0,0,0,0.4);
    }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #e2e8f0; }
    .book-title {
      color: #63b3ed;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 32px;
      padding: 12px 20px;
      background: rgba(99,179,237,0.1);
      border-radius: 12px;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      text-decoration: none;
      padding: 16px 36px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.5px;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 8px 24px rgba(102,126,234,0.4);
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(102,126,234,0.5); }
    .warning {
      margin-top: 24px;
      font-size: 12px;
      color: rgba(255,255,255,0.4);
      line-height: 1.6;
    }
    .auto-dl { margin-top: 12px; font-size: 13px; color: rgba(255,255,255,0.5); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📗</div>
    <h1>TeacherMada</h1>
    <div class="book-title">${promo.books.title}</div>
    <a href="${signedData.signedUrl}" class="btn" id="dlBtn">
      ⬇️ Télécharger le livre
    </a>
    <div class="warning">
      ⚠️ Ce lien expire dans 1 heure<br>
      Usage unique — ne pas partager
    </div>
    <div class="auto-dl">Téléchargement automatique dans <span id="countdown">5</span>s...</div>
  </div>
  <script>
    let n = 5;
    const el = document.getElementById('countdown');
    const timer = setInterval(() => {
      n--;
      el.textContent = n;
      if (n <= 0) {
        clearInterval(timer);
        window.location.href = '${signedData.signedUrl}';
      }
    }, 1000);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
});

// ── Page d'erreur HTML ───────────────────────────────────────
function htmlResponse(message: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Erreur — TeacherMada</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f172a; color: white; }
    .box { text-align: center; padding: 40px; background: rgba(255,255,255,0.05); border-radius: 16px; max-width: 380px; }
    h2 { margin-bottom: 12px; color: #f87171; }
    p { color: rgba(255,255,255,0.6); font-size: 14px; }
  </style>
</head>
<body>
  <div class="box"><h2>⚠️ Erreur</h2><p>${message}</p></div>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
