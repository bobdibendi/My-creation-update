# TODO — FINALISATION AVANT COMMERCIALISATION

> État au **26/08/2026**. Légende :
> - ✅ **TERMINÉ ET VÉRIFIÉ** — exécuté et constaté localement lors de cette session
> - 🟡 **PASS LOCAL UNIQUEMENT** — validé sur mocks/serveurs locaux, pas en conditions réelles
> - 🔵 **ACTION EXTERNE** — à exécuter par l'utilisateur (compte, achat, publication…)
> - 🔴 **RESTE À FAIRE**
> - ⚙️ **CONFIGURATION MANUELLE**

---

## 1. Supabase / Auth (`otp_expired`)

✅ **TERMINÉ ET VÉRIFIÉ (code)** — tous les prérequis sont en place et n'ont pas été modifiés :
- flux **PKCE explicite** (`src/lib/supabase.ts` : `flowType: 'pkce'`, `detectSessionInUrl: false`)
- `emailRedirectTo = mycreation://auth/callback` (`AUTH_REDIRECT_URL`, `src/lib/authCallback.ts`)
- deep link capté **à froid** (argv) et **à chaud** (`second-instance`), transmis une seule fois au renderer
- échange code↔session unique (`processedUrls`), erreurs mappées en messages clairs (`otp_expired` → invitation à se reconnecter)
- pont identité → SQLite (`ensureSupabaseUser`) puis statut licence FREE

🔵 **ACTION EXTERNE — protocole de test réel** (non exécutable par un agent) :
1. Supabase Dashboard → Authentication → URL Configuration : vérifier que
   `mycreation://auth/callback` figure dans **Redirect URLs**.
2. Depuis My Creation : signup avec une VRAIE adresse e-mail neuve.
3. Recevoir le vrai e-mail Supabase, cliquer **UNE SEULE FOIS** sur le lien.
4. Résultat attendu : retour dans My Creation, notice « Adresse email confirmée. »,
   session récupérée, arrivée dans My Creation avec plan **FREE**.
   - Si `otp_expired` persiste : noter l'URL complète du lien reçu (paramètre
     `redirect_to=`) et la comparer à la allowlist AVANT toute modification code.
5. Logout → login (mot de passe) → redémarrage de l'app → session restaurée.

✅ **VÉRIFIÉ RÉELLEMENT le 26/08** (connectivité production) :
- projet configuré : `https://ogdaolavbemomkiiusvv.supabase.co` + clé
  publishable (anon) présente dans `.env.local`
- `GET /auth/v1/health` avec la clé de l'app : **HTTP 200**
  (`{"version":"v2.195.0","name":"GoTrue"}`) — service auth en ligne et clé valide
- endpoint `/auth/v1/signup` joignable (OPTIONS HTTP 200)

🔴 **RESTE À FAIRE** : ce test réel complet (aucun contournement de confirmation
e-mail ; nécessite une boîte mail réelle — action utilisateur).

---

## 2. Rotation RSA / Lifetime

✅ **TERMINÉ ET VÉRIFIÉ** :
- nouvelle paire **RSA-2048 RS256** générée (`scripts/rotate-rsa.cjs --force`)
- clé privée déplacée dans **`license-generator/secrets/private.pem`** (ignorée Git,
  hors chemins d'empaquetage) ; `electron/keys/private.pem` **supprimée**
- `electron/keys/public.pem` remplacée (copiée vers `dist-electron/keys/` au build)
- 15 scripts de test/outils réoutés vers le résolveur partagé `scripts/keys.cjs`
  (`MC_PRIVATE_KEY_PATH` > `LICENSE_PRIVATE_KEY_PATH` > secrets/ > historique)
- License Generator : nouveaux emplacements de recherche documentés
- **preuve cryptographique** : une licence signée avec la clé privée FUGÉE
  (extraite de l'historique Git) est **REJETÉE** par la nouvelle clé publique

Empreintes SHA-256 (clés publiques) :

| Paire | Empreinte | Statut |
|---|---|---|
| Historique Git (`fe6191f`) | `af0560577f2675c909c178272e7bee70b5bbfabb09862ed3e694e872af493e01` | RETIRÉE |
| Dernière paire locale pré-rotation | `103d8e114bd742c0064dc3218294e8c5bec33cac3aa55aca55d1facad515a030` | RETIRÉE |
| **Paire ACTIVE** | `c5fad623f1d2401363984b974fda8359609b7004e4145763ecbeae151b9c2112` | active |

⚠️ **Migration documentée** (README.md § « Rotation des clés de licence ») :
toute licence signée avec une ancienne clé est refusée par les builds récents ;
ré-émettre les licences Lifetime à vendre avec le License Generator à jour.

🔴 **Historique Git** : l'ancienne clé privée reste visible dans l'historique
local (`git show fe6191f:electron/keys/private.pem`). La rotation la rend
inoffensive pour les licences futures, mais si le dépôt est publié un jour,
purger l'historique (`git filter-repo`) ou publier un dépôt neuf sans historique.

✅ **RE-VÉRIFIÉ le 26/08/2026** (`node scripts/verify-rsa-state.cjs`, lecture
seule, aucune régénération) : **10/10 PASS** — paire ACTIVE intacte
(fp `c5fad623…` confirmé sur public.pem + clé publique dérivée de la privée +
roundtrip signature/vérification + clé embarquée dans dist-electron + aucun
matériel de clé privée dans dist/dist-electron/release y compris app.asar).
**Règle** : ne régénérer QUE si un test prouve une corruption/compromission ;
toute licence Lifetime commerciale doit être signée avec cette paire active
(License Generator uniquement).

---

## 3. Gumroad

✅ **TERMINÉ ET VÉRIFIÉ (config locale)** :
- Product IDs renseignés dans `electron/config/gumroad-products.ts` :
  - `PRO_PRODUCT_ID = 'fqcefy'` (https://mycreationliscence.gumroad.com/l/fqcefy)
  - `PRO_ULTIMATE_PRODUCT_ID = 'rbdvn'` (https://mycreationliscence.gumroad.com/l/rbdvn)
- vérifié **embarqués dans app.asar** du build 1.0.0 (identifiants publics, pas des secrets)
- suite Gumroad locale (API mockée) : **15 PASS, 0 FAIL**
- aucun secret/token Gumroad côté client (architecture inchangée)

🟡 **PASS LOCAL UNIQUEMENT** — les scénarios payants réels ne sont pas testables
sans vrais achats :

⚠️ **RE-CONSTAT RÉEL SUR LES PAGES PRODUITS PUBLIQUES (26/08, 2e vérification,
HTML source)** :

| Produit | ID | Récurrences proposées | Prix constatés |
|---|---|---|---|
| My Creation Pro | `fqcefy` | **monthly uniquement** ✓ | ✅ option unique à **9,99 €/mois** (`price_cents: 999`, `is_pwyw: false`) — le PWYW 0 € a bien été retiré |
| My Creation Pro Ultimate | `rbdvn` | ⚠️ **monthly ET yearly toujours activées** (re-vérifié) | « My Creation Pro » : **30 €/mois** ou **360 €/an** (`is_pwyw: false`) |

⚠️ Résiduel fqcefy : le champ `analytics.free_sales: true` reste visible dans la
page publique et `product.price_cents: 0` au niveau racine (artefact membership
« tiered »). À confirmer dans le dashboard : désactiver « Allow free sales » si
l'option existe, pour garantir qu'aucun chemin de checkout à 0 € ne subsiste.

🔴 **BLOCS COMMERCIAUX À CORRIGER DANS LE DASHBOARD GUMROAD** :
1. ~~fqcefy gratuit en pratique~~ → **CORRIGÉ côté Gumroad** (option à 9,99 €/mois
   constatée en direct) ; reste la confirmation du réglage free-sales (voir ⚠️).
2. **rbdvn propose TOUJOURS yearly alors que le code suppose monthly**
   (`PRO_ULTIMATE_RECURRENCE: 'monthly'`, `electron/config/gumroad-products.ts`).
   L'API `/v2/licenses/verify` n'expose PAS la récurrence choisie par l'acheteur :
   un produit doit n'avoir QU'UNE récurrence. Un acheteur yearly verrait son
   abonnement expirer localement après ~37 jours malgré 12 mois payés.
   Correction requise : **désactiver la récurrence yearly sur rbdvn**
   (ou vendre yearly uniquement et passer la constante à 'yearly').
3. **rbdvn : contenu dupliqué de Pro** — l'option s'appelle toujours
   « My Creation Pro » (re-vérifié en direct) ; à renommer/décrire pour Ultimate.
4. Les deux produits ont `sales_count: 0` — aucun achat réel n'a encore eu lieu.

🔵 **ACTION EXTERNE** (sur https://mycreationliscence.gumroad.com) :
- [ ] Monthly → PRO ; Annual → PRO
- [ ] Renouvellement → PRO maintenu (sale_timestamp avance)
- [ ] Annulation → PRO jusqu'à fin de période payée puis FREE
- [ ] Non-renouvellement/expiration → FREE
- [ ] Remboursement → accès retiré (kind=refunded)
- [ ] Utilisateur non connecté → aucun PRO

⚙️ **CONFIGURATION MANUELLE** : ~~vérifier la récurrence réelle~~ **FAIT le
26/08** — fqcefy : monthly uniquement ✓ ; rbdvn : monthly + yearly (voir §3,
bloc 2 : désactiver yearly). Les constantes du build (`monthly`) restent
correctes SI yearly est désactivé côté Gumroad.

---

## 4. Auto-update GitHub

✅ Code updater inchangé et fonctionnel (`electron/updater.ts`, autoDownload=false).

### 🐛 BUG BLOQUANT CORRIGÉ (26/08/2026) — « Cannot find module 'electron-updater' »

- **Symptôme** : l'EXE production crashait au lancement (erreur main process,
  `MODULE_NOT_FOUND` depuis `app.asar/dist-electron/updater.js`).
- **Cause exacte** : `electron-updater` avait été retiré de
  `package.json > dependencies` (régression du manifeste, restée sans
  `npm install`) alors que `package-lock.json` le déclarait encore. Le module
  restait présent dans `node_modules` local → `tsc` compilait et typecheckait
  correctement, mais electron-builder (qui lit `package.json`, pas le lock)
  ne l' empaquetait PAS dans app.asar. Au chargement, `require('electron-updater')`
  échouait dans le main process.
- **Fichiers modifiés** :
  - `package.json` : restauration de `"electron-updater": "^6.6.2"` ET de
    `"@supabase/supabase-js": "^2.112.4"` dans `dependencies` (ce dernier,
    également absent du manifeste, aurait été élagué au prochain
    `npm install` et aurait cassé le typecheck) ;
  - `package-lock.json` : resynchronisé par `npm install`
    (`electron-updater@6.6.2` puis `6.8.9` après `npm audit fix`, voir §6) ;
  - `scripts/verify-rsa-state.cjs` : nouvel outil de vérification d'état RSA
    (lecture seule).
- **Aucune modification** de updater.ts / main.ts / Supabase / Gumroad / RSA /
  LicenseService / Agent / Monaco / Runtime ; auto-update NON désactivé ;
  aucun try/catch masquant.

🔴 **RESTE À FAIRE — ACTION EXTERNE obligatoire** : **aucun remote Git n'existe**
(revérifié le 26/08 : `git remote -v` vide, CLI `gh` absente) et
`build.publish` pointe encore vers un provider `generic` fictif
(`https://example.com/cursor-clone/updates/`). Procédure :
1. Créer le repo GitHub public, y pousser le projet.
2. Dans `package.json > build.publish` : `{ "provider": "github", "owner": "...", "repo": "..." }`.
3. Rebuild + `electron-builder --publish always` avec `GH_TOKEN`.
4. Publier Release N (ex. 1.0.0) avec Setup.exe + latest.yml + .blockmap.
5. Bumper version (N+1), republier, installer N sur une machine, tester :
   détection → téléchargement → installation → redémarrage → session conservée,
   SQLite conservée, licence conservée, paramètres conservés.

⚠️ Ne pas déclarer l'auto-update « E2E validé » sur la base des tests locaux :
seul le flux réel ci-dessus compte.

---

## 5. Signature Windows

✅ **VÉRIFIÉ RÉELLEMENT** (26/08, `Get-AuthenticodeSignature` sur les artefacts
finaux) : **`My Creation Setup 1.0.0.exe` et `win-unpacked\My Creation.exe`
sont NON SIGNÉS** (`Status: NotSigned`) ; aucun certificat de signature de code
dans le magasin Windows (CurrentUser/LocalMachine) ni configuré dans `build.win`.

➡️ **STATUT EXPLICITE : NON SIGNÉ — certificat à acquérir (OVH/DigiCert…).**

🔴 **RESTE À FAIRE** (si certificat obtenu un jour) :
- signer installateur + EXE (`certificateSubjectName`/`certificateFile` dans
  `build.win`, ou signtool post-build)
- vérifier signature + identité du signataire

⚠️ En l'état : SmartScreen affichera « Éditeur inconnu ». NE PAS prétendre à
une signature commerciale authentique dans la communication produit.

---

## 6. Scan sécurité final

✅ **TERMINÉ ET VÉRIFIÉ** — rejoué sur le build final corrigé
(`scripts/security-scan.cjs`) :
- périmètre : `dist/`, `dist-electron/`, `release/` (win-unpacked + **app.asar**
  lu intégralement + installateur), 202 fichiers
- résultat : **0 détection** — pas de private.pem, pas d'empreinte des clés
  retirées, pas de secret/service_role Supabase, pas de token Gumroad, pas de
  mot de passe BDD, pas de clé IA en dur
- clé publique ACTIVE embarquée vérifiée (fp `c5fad623…`)
- Product IDs Gumroad publics présents (attendus)
- `npm audit` : **0 vulnérabilité** (après `npm audit fix` du 26/08 :
  `electron-updater` 6.6.2 → **6.8.9**, corrige GHSA-p2f4-r6v6-j797 — fuite
  d'en-têtes d'authentification dans `builder-util-runtime` < 9.7.0 lors de
  redirections cross-origin ; correction dépendance uniquement, aucun code
  modifié, revalidation complète effectuée §7)

✅ Les anciens installateurs `My Creation Setup 1.x.exe` ont été retirés de
`release/` : seul `My Creation Setup 1.0.0.exe` + `latest.yml` y figurent.

---

## 7. Build / release finale (1.0.0) — RECONSTRUIT ET REVÉRIFIÉ le 26/08

✅ **TERMINÉ ET VÉRIFIÉ** après correction electron-updater :
- `npm install` puis chaîne complète rejouée :
  - `npm run typecheck` : **PASS**
  - `npm run lint` : **PASS**
  - `npm test` : Providers PASS · Runtime PASS · Anti-falsification **9/9 PASS** ·
    Renderer PASS · Application PASS · Agent **15/16** (échec externe connu,
    voir Limitations)
- `npm run dist` : installateur NSIS régénéré
- **app.asar inspecté physiquement** : `electron-updater@6.8.9` présent (32
  fichiers) avec TOUTES ses dépendances (`builder-util-runtime@9.7.0` inclus),
  `dist-electron/updater.js` empaqueté
- **EXE win-unpacked lancé réellement** (copié hors du projet,
  `scripts/test-package.cjs`) : **46/46 PASS** — démarrage sans erreur main
  process, renderer servi depuis app.asar, pont preload complet, IPC fichiers/
  providers/trousseau/chat/agent/terminal/git/preview/analyse OK, workers
  Monaco OK
- **Auto-update vérifié sur l'EXE packagé** : module chargé (stack d'erreur
  réseau émise depuis `app.asar/node_modules/builder-util-runtime/`),
  `update:supported=true`, check réel exécuté vers le provider configuré
  (404 attendu tant que le repo GitHub n'existe pas), erreur remontée proprement
  en event sans crash, `autoDownload=false` inchangé
- **Installateur testé en réel** (`scripts/test-installer.cjs`) :
  installation silencieuse → raccourcis → registre → **lancement de l'EXE
  INSTALLÉ** (UI rendue, preload fonctionnel, titre correct) → désinstallation
  silencieuse complète, machine laissée propre : **31/31 PASS**
- `latest.yml` : version 1.0.0, **SHA512 vérifié = SHA512 calculé du Setup.exe**

🔵 **ACTION EXTERNE** : installer réellement le Setup 1.0.0 sur une machine
propre, tester l'EXE installé (compte, licence, chat, terminal, preview).

---

## 8. RESTE À FAIRE avant commercialisation (synthèse — 26/08 soir, session 2)

**Session 2 (26/08 fin de journée) — corrections de code appliquées et revérifiées :**
- `electron/plans.ts` : prix PRO affiché « Sur devis » → **« 9,99 € / mois »**
  (aligné sur le produit Gumroad fqcefy réel) ; description FREE corrigée
  (le compte est requis à l'entrée de l'app) — constaté embarqué dans app.asar.
- `src/hooks/useAuth.ts` : **changement de mot de passe désormais fonctionnel
  pour les comptes Supabase** (re-vérification réelle de l'ancien mot de passe via
  `signInWithPassword` puis `updateUser({password})`) — l'ancien chemin local
  échouait systématiquement (hash local inutilisable par conception).
- `src/hooks/useAuth.ts` + `AccountPanel.tsx` : **changement d'e-mail réel**
  (`updateUser({email})` → e-mail de confirmation envoyé ; libellés honnêtes).
- `ConsumptionCard` / i18n : note « limite partagée entre les utilisateurs »
  (fausse) remplacée par le libellé véridique (limite quotidienne par compte,
  reset minuit UTC).
- `App.tsx` : événement `plan:update` resynchronise aussi le statut licence
  complet (récupération d'un échec IPC transitoire au boot).
- `RELEASE.md` créé : processus release N/N+1, migration provider GitHub,
  préparation signature Windows.

**Re-vérifications réelles session 2** : typecheck PASS · lint PASS · npm test
(Providers/Runtime/Anti-falsification 9/9/Renderer/Application PASS, Agent 15/16)
· build + installateur régénérés · verify-rsa-state 10/10 PASS · security-scan
202 fichiers 0 détection · test-package **51/51 PASS** · test-installer
**31/31 PASS** · latest.yml SHA512 = SHA512 Setup.exe (MATCH) · Authenticode :
Setup et EXE **NotSigned** · Product IDs fqcefy/rbdvn + api.gumroad.com présents
dans app.asar · Supabase `/auth/v1/health` HTTP 200 (avec clé publishable).

| # | Élément | Type |
|---|---|---|
| 1 | Test réel signup → lien e-mail unique → session → FREE → logout/login/restart (§1) | ACTION EXTERNE (boîte mail réelle requise) |
| 2 | Créer repo GitHub + configurer `build.publish` + Release N/N+1 + E2E update réel (§4) | ACTION EXTERNE (compte GitHub requis) |
| 3 | ~~fqcefy : fixer un prix réel~~ **FAIT côté Gumroad** (9,99 €/mois constaté en direct). Reste : confirmer l'absence de chemin gratuit dans le checkout (réglage free-sales, §3 ⚠️) | CONFIG. MANUELLE |
| 4 | **rbdvn : désactiver la récurrence yearly** (re-vérifié encore active, §3) | 🔴 BLOCAGE CONFIG GUMROAD |
| 5 | rbdvn : corriger nom/description de l'option (toujours dupliqués de Pro, §3) | CONFIG. MANUELLE |
| 6 | Achats Gumroad réels : achat→PRO / annulation / expiration→FREE / refund / non-connecté (§3) | ACTION EXTERNE |
| 7 | Certificat de signature Windows OVH/DigiCert + signature + vérification (§5) — artefacts actuels NotSigned re-vérifiés | 🔴 BLOCAGE CERTIFICAT |
| 8 | Ré-émettre les licences Lifetime à vendre avec la paire ACTIVE (`c5fad623…`) | CONFIG. MANUELLE |
| 9 | Décider du traitement de l'historique Git contenant l'ancienne clé (§2) avant toute publication du dépôt | CONFIG. MANUELLE |
| 10 | Rejouer la suite Agent complète quand Top-Tools-Ai sera stable (15/16 aujourd'hui, timeout fournisseur réel sur « Site web complet ») | À REJOUER |

> ~~Purger/archiver les anciens installateurs 1.x de `release/`~~ — **FAIT**
> (vérifié le 26/08 : seul `My Creation Setup 1.0.0.exe` reste dans `release/`).

## Limitations connues

- **Agent « Site web complet »** : échec systématique depuis le 26/08 matin
  (runs répétés, dernier en soirée : « writeFile non appelé », précédemment
  « Le fournisseur n'a pas répondu en 45 s » / HTTP 502 côté Top-Tools-Ai).
  **BLOQUÉ PAR DÉPENDANCE EXTERNE** — dégradation confirmée chez le
  fournisseur ; les 15 autres scénarios passent. Aucune modification code n'a
  touché l'agent/runtime/providers. Le 16e test n'est PAS compté comme PASS.
- **Signature Windows absente** : artefacts finaux `NotSigned` (Authenticode,
  vérifié 26/08). Comportement SmartScreen « éditeur inconnu ». Ne pas prétendre
  à une signature dans la communication produit.
- **Auto-update** : inerte tant que le provider GitHub n'est pas configuré et
  qu'aucune Release n'existe (les handlers répondent proprement, erreur réseau
  gérée sans crash — vérifié sur l'EXE packagé).
- **Gumroad fqcefy payable 0 €** tant que le prix n'est pas corrigé (§3).
