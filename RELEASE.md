# PROCESSUS DE RELEASE — My Creation

> Source de vérité pour publier la version N puis N+1 avec auto-update fonctionnel.
> Toute étape marquée **[EXTERNE]** nécessite un compte/service externe : ne pas
> la considérer comme faite sans preuve réelle (Release visible, signature vérifiée…).

## 0. Prérequis (état actuel)

- Paire RSA licences ACTIVE : empreinte publique `c5fad623f1d2401363984b974fda8359609b7004e4145763ecbeae151b9c2112`.
  Ne JAMAIS régénérer. Vérification avant chaque release : `node scripts/verify-rsa-state.cjs` → 10/10 PASS.
- Product IDs Gumroad embarqués (`electron/config/gumroad-products.ts`) : `fqcefy` (Pro), `rbdvn` (Ultimate).
- Provider de publication actuel dans `package.json > build.publish` : `generic/example.com`
  (placeholder — l'auto-update est inerte tant que GitHub n'est pas configuré).

## 1. Release version N

1. Vérifier l'état : `node scripts/verify-rsa-state.cjs`
2. Qualité : `npm run typecheck && npm run lint && npm test`
3. Versionner : modifier `"version"` dans `package.json` (ex. `1.0.0`) — semver strict,
   l'auto-update compare les versions.
4. Builder + packager : `npm run dist`
   - produit `release/My Creation Setup <version>.exe`, `.blockmap`, `latest.yml`
5. Vérifier les artefacts :
   - `node scripts/test-package.cjs` (EXE win-unpacked)
   - `node scripts/test-installer.cjs` (installation/désinstallation réelle)
   - SHA512 : comparer le champ `sha512` de `latest.yml` au fichier Setup
     (`Get-FileHash -Algorithm SHA512 "release\My Creation Setup <version>.exe"`)
6. Publier **[EXTERNE]** : voir §3 (GitHub).

## 2. Release version N+1 (auto-update réel)

1. Modifier le code, incrémenter `"version"` (ex. `1.0.1`).
2. Refaire §1 (étapes 1→5).
3. Publier la Release N+1 sur GitHub **[EXTERNE]** (§3) : attacher
   `My Creation Setup <version>.exe`, `latest.yml`, `.blockmap`.
4. Test E2E réel **[EXTERNE]** : sur une machine ayant la version N installée :
   ouvrir l'app → « Vérifier les mises à jour » (Settings) → détection de N+1 →
   téléchargement → « Redémarrer » → app en N+1, session/licence/réglages conservés.
5. Ne déclarer l'auto-update validé QU'APRÈS ce test réel.

## 3. Migration provider GitHub **[EXTERNE]**

Aucun remote n'existe actuellement. Une fois le repo créé :

1. Créer le repo GitHub public (owner/repo), y pousser ce projet.
2. Dans `package.json` :
   ```json
   "publish": [
     { "provider": "github", "owner": "<OWNER>", "repo": "<REPO>", "channel": "latest" }
   ]
   ```
3. Créer un Personal Access Token (scope `repo`) → variable d'environnement `GH_TOKEN`.
4. `npm run dist -- --publish always` OU uploader manuellement les 3 artefacts sur la Release.
5. Vérifier : la page Releases montre le tag `v<version>` + les artefacts ;
   `latest.yml` présent et cohérent (version + sha512 + nom de fichier exacts).
6. L'app installée doit alors trouver `https://github.com/<OWNER>/<REPO>/releases/latest`.

## 4. Signature Windows **[EXTERNE]** — obligatoire avant commercialisation

État actuel : artefacts NON SIGNÉS (Authenticode vérifié). SmartScreen affichera
« éditeur inconnu ». Aucune simulation possible.

1. Acquérir un certificat de signature de code (OV, EV ; OVH/DigiCert/Sectigo…).
2. Configurer `package.json > build.win` :
   ```json
   "win": {
     "certificateSubjectName": "<CN exact du certificat>",
     "rfc3161TimeStampServer": "http://timestamp.digicert.com",
     "signingHashAlgorithms": ["sha256"]
   }
   ```
   (ou `certificateFile` + `certificatePassword` pour un .pfx)
3. Rebuilder, puis vérifier RÉELLEMENT :
   ```powershell
   Get-AuthenticodeSignature "release\My Creation Setup <version>.exe"
   # Status doit être « Valid », SignerCertificate non null
   ```

## 5. Checklist avant publication commerciale

- [ ] `node scripts/verify-rsa-state.cjs` → 10/10 PASS
- [ ] `npm run typecheck && npm run lint && npm test` → PASS
- [ ] Licences Lifetime à vendre générées avec la paire ACTIVE uniquement
- [ ] Prix Gumroad réels (fqcefy = 9,99 €/mois, PWYW/free-sales désactivés)
- [ ] rbdvn : récurrence yearly désactivée OU code aligné (UNE seule récurrence par produit)
- [ ] Release GitHub publiée avec latest.yml + SHA512 vérifiés
- [ ] Installateur signé (Status: Valid) — sinon mentionner explicitement « non signé »
- [ ] Test signup e-mail réel effectué (lien unique → session → FREE)
