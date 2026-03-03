-- ================================================================
-- 🗄️  TEACHERMADA BOT — SCHÉMA SUPABASE COMPLET v3
-- ================================================================
-- Exécuter dans : Supabase → SQL Editor (en une seule fois)
-- ================================================================

-- ────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";     -- nettoyage automatique

-- ================================================================
-- TABLE 1 : BOOKS — Catalogue des livres PDF
-- ================================================================
-- L'IA consulte cette table pour connaître les livres disponibles
-- et les recommander intelligemment aux utilisateurs.
-- ================================================================
CREATE TABLE IF NOT EXISTS books (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,                          -- résumé pour l'IA
  subject       TEXT,                          -- ex: "Anglais", "Maths"
  level         TEXT,                          -- ex: "Lycée", "Université"
  price         NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'MGA',
  storage_path  TEXT NOT NULL,                 -- chemin dans Supabase Storage
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_books_active   ON books(is_active);
CREATE INDEX idx_books_subject  ON books(subject);

-- ================================================================
-- TABLE 2 : PROMOS — Codes d'achat à usage unique
-- ================================================================
CREATE TABLE IF NOT EXISTS promos (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code           TEXT UNIQUE NOT NULL,          -- format TM-XXXXXX
  book_id        UUID REFERENCES books(id) ON DELETE SET NULL,
  download_token TEXT UNIQUE,                   -- token signé temporaire
  used           BOOLEAN DEFAULT FALSE,
  token_used     BOOLEAN DEFAULT FALSE,         -- téléchargement effectué
  created_by     TEXT,                          -- PSID admin créateur
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL           -- 24h après création
);

CREATE INDEX idx_promos_code           ON promos(code);
CREATE INDEX idx_promos_download_token ON promos(download_token);
CREATE INDEX idx_promos_expires_at     ON promos(expires_at);

-- ================================================================
-- TABLE 3 : SALES — Enregistrement de chaque vente
-- ================================================================
CREATE TABLE IF NOT EXISTS sales (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  promo_id     UUID REFERENCES promos(id) ON DELETE SET NULL,
  book_id      UUID REFERENCES books(id) ON DELETE SET NULL,
  sender_psid  TEXT NOT NULL,                   -- ID Facebook de l'acheteur
  page_id      TEXT,
  amount       NUMERIC(10,2),
  currency     TEXT DEFAULT 'MGA',
  status       TEXT DEFAULT 'completed',        -- completed | refunded
  sold_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sales_sender   ON sales(sender_psid);
CREATE INDEX idx_sales_book     ON sales(book_id);
CREATE INDEX idx_sales_sold_at  ON sales(sold_at);

-- ================================================================
-- TABLE 4 : CONVERSATION_HISTORY — Historique brut (24h max)
-- ================================================================
-- Limité volontairement pour le plan gratuit Supabase.
-- Nettoyage automatique toutes les heures.
-- Max 20 messages par utilisateur via trigger.
-- ================================================================
CREATE TABLE IF NOT EXISTS conversation_history (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  sender_psid TEXT NOT NULL,
  page_id     TEXT,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  token_count INT DEFAULT 0,                    -- estimation tokens consommés
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conv_psid       ON conversation_history(sender_psid);
CREATE INDEX idx_conv_created    ON conversation_history(created_at);

-- ────────────────────────────────────────────────────────────────
-- TRIGGER : Limite à 20 messages par utilisateur
-- Supprime les plus anciens automatiquement.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_history_limit()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM conversation_history
  WHERE sender_psid = NEW.sender_psid
    AND id IN (
      SELECT id FROM conversation_history
      WHERE sender_psid = NEW.sender_psid
      ORDER BY created_at DESC
      OFFSET 19                                 -- garde les 20 plus récents
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_history_limit
  AFTER INSERT ON conversation_history
  FOR EACH ROW EXECUTE FUNCTION enforce_history_limit();

-- ================================================================
-- TABLE 5 : AI_MEMORY — Mémoire permanente intelligente par user
-- ================================================================
-- Contrairement à conversation_history (éphémère), cette table
-- conserve un RÉSUMÉ intelligent généré par Gemini :
--   - préférences de l'utilisateur
--   - livres déjà achetés
--   - niveau scolaire
--   - sujets d'intérêt
--
-- Mise à jour intelligente toutes les 10 interactions.
-- Une seule ligne par (sender_psid, page_id).
-- ================================================================
CREATE TABLE IF NOT EXISTS ai_memory (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  sender_psid     TEXT NOT NULL,
  page_id         TEXT,
  summary         TEXT NOT NULL DEFAULT '',     -- résumé Gemini de la relation
  books_purchased TEXT[] DEFAULT '{}',          -- titres des livres achetés
  preferences     JSONB DEFAULT '{}',           -- {level, subjects, language}
  interaction_count INT DEFAULT 0,              -- nombre total d'interactions
  last_summarized_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sender_psid, page_id)
);

CREATE INDEX idx_memory_psid ON ai_memory(sender_psid);

-- ================================================================
-- TABLE 6 : PAGES — Configuration multi-pages Facebook
-- ================================================================
CREATE TABLE IF NOT EXISTS pages (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  page_id      TEXT UNIQUE NOT NULL,
  page_name    TEXT,
  access_token TEXT NOT NULL,                   -- stocké chiffré (vault idéalement)
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ================================================================
-- FONCTIONS UTILITAIRES
-- ================================================================

-- Mise à jour automatique de updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_books_updated   BEFORE UPDATE ON books   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_memory_updated  BEFORE UPDATE ON ai_memory FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Vue : catalogue livres pour l'IA (sans chemins de stockage)
CREATE OR REPLACE VIEW books_catalog AS
SELECT id, title, description, subject, level, price, currency, is_active
FROM books
WHERE is_active = TRUE;

-- Vue : statistiques ventes par livre
CREATE OR REPLACE VIEW sales_stats AS
SELECT
  b.title,
  b.subject,
  COUNT(s.id)        AS total_sales,
  SUM(s.amount)      AS total_revenue,
  MAX(s.sold_at)     AS last_sale_at
FROM books b
LEFT JOIN sales s ON b.id = s.book_id
GROUP BY b.id, b.title, b.subject;

-- ================================================================
-- 🧹 NETTOYAGE AUTOMATIQUE VIA pg_cron
-- ================================================================

-- Toutes les heures : supprimer historique > 24h
SELECT cron.schedule(
  'cleanup-conversation-history',
  '0 * * * *',
  $$
    DELETE FROM conversation_history
    WHERE created_at < NOW() - INTERVAL '24 hours';
  $$
);

-- Chaque nuit à 2h : supprimer promos expirées > 48h
SELECT cron.schedule(
  'cleanup-expired-promos',
  '0 2 * * *',
  $$
    DELETE FROM promos
    WHERE expires_at < NOW() - INTERVAL '48 hours';
  $$
);

-- Chaque dimanche à 3h : résumé mémoire IA des users inactifs
-- (déclenche la Edge Function de résumé)
SELECT cron.schedule(
  'summarize-inactive-users',
  '0 3 * * 0',
  $$
    -- Marquer les users avec > 10 interactions non résumés depuis 7 jours
    UPDATE ai_memory
    SET last_summarized_at = NULL
    WHERE interaction_count > 10
      AND last_summarized_at < NOW() - INTERVAL '7 days';
  $$
);

-- ================================================================
-- ROW LEVEL SECURITY
-- ================================================================

ALTER TABLE books                ENABLE ROW LEVEL SECURITY;
ALTER TABLE promos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales                ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages                ENABLE ROW LEVEL SECURITY;

-- Seul le service_role (Edge Functions) peut tout faire
CREATE POLICY "service_role_all" ON books                FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON promos               FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON sales                FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON conversation_history FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON ai_memory            FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON pages                FOR ALL USING (auth.role() = 'service_role');

-- Admin dashboard peut lire (via anon key + RLS)
CREATE POLICY "admin_read_books"  ON books  FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "admin_read_sales"  ON sales  FOR SELECT USING (auth.role() = 'anon');

-- ================================================================
-- DONNÉES INITIALES — Exemple livre
-- ================================================================
INSERT INTO books (title, description, subject, level, price, currency, storage_path)
VALUES (
  'Anglais en 5 minutes',
  'Méthode rapide pour maîtriser l''anglais en 5 minutes par jour. Idéal pour lycéens et étudiants malgaches.',
  'Anglais',
  'Lycée / Université',
  5000,
  'MGA',
  'books/ANGLAIS_5MIN.pdf'
)
ON CONFLICT DO NOTHING;
