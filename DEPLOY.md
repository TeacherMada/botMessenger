# 🚀 Guide de Déploiement — TeacherMada v3
## Architecture : Supabase Only + Render Static

---

## 📁 Structure du projet

```
teachermada-v3/
├── supabase/
│   ├── config.toml
│   └── functions/
│       ├── _shared/               ← Modules partagés entre fonctions
│       │   ├── db.ts              ← Client Supabase
│       │   ├── messenger.ts       ← Envoi messages Facebook
│       │   ├── gemini.ts          ← Agent IA + catalogue livres
│       │   ├── memory.ts          ← Mémoire intelligente (2 niveaux)
│       │   └── promo.ts           ← Codes promo + liens signés
│       ├── webhook/index.ts       ← Webhook Messenger (REMPLACE Express)
│       ├── download/index.ts      ← Téléchargement PDF sécurisé
│       └── cleanup/index.ts       ← Nettoyage automatique
├── database/
│   └── schema.sql                 ← Schéma SQL complet optimisé
├── admin/
│   └── index.html                 ← Dashboard admin (Render Static)
└── .env.example
```

---

## ÉTAPE 1 — Supabase : Base de données

### 1.1 Créer le projet
- https://supabase.com → **New Project**
- Région : `eu-west-1` (ou proche de Madagascar)
- Garder le mot de passe DB

### 1.2 Activer les extensions
- **Database** → **Extensions** → activer `pg_cron` et `uuid-ossp`

### 1.3 Exécuter le schéma
- **SQL Editor** → **New Query** → coller `database/schema.sql` → **Run**

---

## ÉTAPE 2 — Supabase : Storage

### 2.1 Créer le bucket `books`
1. **Storage** → **New Bucket**
2. Name : `books`
3. **Private** (pas public) ← Important pour la sécurité
4. File size limit : 50 MB

### 2.2 Policy Storage
Dans **Storage** → **Policies** → bucket `books` :
- Autoriser uniquement `service_role` à lire (les Edge Functions)

### 2.3 Uploader les PDFs
- **Storage** → `books` → **Upload file**
- Le chemin doit correspondre à `storage_path` dans la table `books`
- Ex : `books/ANGLAIS_5MIN.pdf`

---

## ÉTAPE 3 — Supabase : Auth Admin

### 3.1 Créer l'utilisateur admin du dashboard
- **Authentication** → **Users** → **Add User**
- Email : votre email admin
- Password : mot de passe fort

### 3.2 RLS pour le dashboard
Le dashboard utilise l'`anon key` — les policies RLS dans le schéma
autorisent déjà la lecture en SELECT pour `books` et `sales`.

---

## ÉTAPE 4 — Supabase : Edge Functions

### 4.1 Installer Supabase CLI
```bash
npm install -g supabase
supabase login
supabase link --project-ref VOTRE_PROJECT_REF
```

### 4.2 Configurer les secrets
```bash
supabase secrets set VERIFY_TOKEN="votre_token_webhook"
supabase secrets set ADMIN_IDS="psid1,psid2"
supabase secrets set GEMINI_API_KEY="AIza..."
supabase secrets set EDGE_FUNCTION_BASE_URL="https://PROJET.supabase.co/functions/v1"
supabase secrets set CLEANUP_SECRET="secret_aleatoire"
```

### 4.3 Déployer les fonctions
```bash
# Déployer toutes les fonctions
supabase functions deploy webhook  --no-verify-jwt
supabase functions deploy download --no-verify-jwt
supabase functions deploy cleanup  --no-verify-jwt
```

> `--no-verify-jwt` est requis pour `webhook` et `download`
> car Facebook et les utilisateurs n'envoient pas de JWT Supabase.

### 4.4 URLs des fonctions déployées
```
Webhook  : https://PROJET.supabase.co/functions/v1/webhook
Download : https://PROJET.supabase.co/functions/v1/download
Cleanup  : https://PROJET.supabase.co/functions/v1/cleanup
```

---

## ÉTAPE 5 — Facebook : Configurer le Webhook

1. https://developers.facebook.com → votre App
2. **Messenger** → **Webhooks** → **Edit Callback URL**
3. URL : `https://PROJET.supabase.co/functions/v1/webhook`
4. Verify Token : valeur de `VERIFY_TOKEN`
5. Abonnements : `messages`, `messaging_postbacks`

### Configurer les pages dans Supabase
Dans le dashboard admin (ou SQL Editor) :
```sql
INSERT INTO pages (page_id, page_name, access_token, is_active)
VALUES ('VOTRE_PAGE_ID', 'TeacherMada', 'EAA...TOKEN...', true);
```

---

## ÉTAPE 6 — Render : Dashboard Admin (Site Statique)

### 6.1 Modifier admin/index.html
Remplacer les 2 lignes de config :
```js
const SUPABASE_URL      = 'https://VOTRE_PROJET.supabase.co';
const SUPABASE_ANON_KEY = 'VOTRE_ANON_KEY'; // Jamais la service_role !
```

### 6.2 Déployer sur Render
1. https://render.com → **New** → **Static Site**
2. Connecter le repo GitHub
3. **Publish Directory** : `admin`
4. **Build Command** : (laisser vide)
5. Deploy → URL : `https://votre-dashboard.onrender.com`

---

## 🧠 Stratégie Mémoire IA — Résumé

```
NIVEAU 1 : conversation_history (éphémère)
  → Stocke les 20 derniers messages max
  → Supprimé automatiquement après 24h
  → Utilisé pour le contexte immédiat de Gemini

NIVEAU 2 : ai_memory (permanent)
  → 1 ligne par utilisateur
  → Résumé intelligent généré par Gemini tous les 10 messages
  → Contient : préférences, livres achetés, niveau, sujets
  → Injecté dans chaque prompt Gemini (mémoire longue)
```

---

## 🧹 Nettoyage automatique — Résumé

| Mécanisme | Déclencheur | Action |
|---|---|---|
| Trigger SQL | À chaque insertion | Limite à 20 msgs/user |
| pg_cron `cleanup-conversation-history` | Toutes les heures | Supprime historique > 24h |
| pg_cron `cleanup-expired-promos` | Chaque nuit à 2h | Supprime promos > 48h |
| Edge Function `cleanup` | Manuel ou cron externe | Nettoyage complet |

---

## ✅ Checklist finale

- [ ] Schéma SQL exécuté
- [ ] Extension pg_cron activée
- [ ] Bucket Storage `books` créé (private)
- [ ] PDFs uploadés dans Storage
- [ ] Livres ajoutés dans table `books`
- [ ] Secrets Edge Functions configurés
- [ ] 3 Edge Functions déployées
- [ ] Webhook Facebook configuré
- [ ] Pages Facebook ajoutées dans table `pages`
- [ ] Dashboard admin : URLs Supabase mises à jour
- [ ] Dashboard déployé sur Render Static
- [ ] Utilisateur admin créé dans Supabase Auth
