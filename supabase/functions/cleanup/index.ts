// supabase/functions/cleanup/index.ts
// ============================================================
// EDGE FUNCTION PLANIFIÉE — Nettoyage automatique
// Déclenchée par pg_cron ou manuellement via HTTP
// ============================================================

import { supabase } from '../_shared/db.ts';

interface CleanupResult {
  conversations_deleted: number;
  promos_deleted: number;
  duration_ms: number;
  timestamp: string;
}

async function runCleanup(): Promise<CleanupResult> {
  const start = Date.now();

  // ── 1. Supprimer l'historique > 24h ──────────────────────
  const cutoffConv = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: convDeleted, error: convErr } = await supabase
    .from('conversation_history')
    .delete({ count: 'exact' })
    .lt('created_at', cutoffConv);

  if (convErr) console.error('❌ Cleanup conversations:', convErr.message);

  // ── 2. Supprimer les promos expirées > 48h ────────────────
  const cutoffPromo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { count: promoDeleted, error: promoErr } = await supabase
    .from('promos')
    .delete({ count: 'exact' })
    .lt('expires_at', cutoffPromo);

  if (promoErr) console.error('❌ Cleanup promos:', promoErr.message);

  // ── 3. Nettoyer l'historique excédentaire (> 20 msgs/user) ─
  // Le trigger s'en charge à l'insertion mais on fait un sweep mensuel
  const { error: sweepErr } = await supabase.rpc('enforce_all_history_limits');
  if (sweepErr) console.error('❌ History sweep:', sweepErr.message);

  const result: CleanupResult = {
    conversations_deleted: convDeleted || 0,
    promos_deleted: promoDeleted || 0,
    duration_ms: Date.now() - start,
    timestamp: new Date().toISOString()
  };

  console.log('🧹 Cleanup terminé:', JSON.stringify(result));
  return result;
}

Deno.serve(async (req: Request) => {
  // Vérification du secret pour appels manuels
  const secret = req.headers.get('x-cleanup-secret');
  const expectedSecret = Deno.env.get('CLEANUP_SECRET');

  if (secret !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await runCleanup();
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
