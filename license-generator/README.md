# My Creation License Generator

Application Electron locale (admin) qui génère les licences JWT RS256 de
My Creation. Même logique et même clé privée que `scripts/generate-license.cjs` :
les licences produites sont directement acceptées par My Creation.

## Sécurité

- Outil **local uniquement** : aucune API distante, aucun envoi réseau.
- La clé privée (`license-generator/secrets/private.pem`, ignorée par Git) est
  lue localement au moment de la signature. Elle n'est **jamais** embarquée
  dans My Creation ni dans le build du générateur, et ne doit jamais quitter
  l'environnement sécurisé de ce poste.
- My Creation ne contient que `public.pem`, utilisée pour vérifier les signatures.

> **Rotation d'août 2026** : l'ancienne paire (empreinte publique SHA-256
> `103d8e11…5a030`) a été retirée car la private key avait transité dans
> l'historique Git. Toute licence signée avec l'ancienne clé est désormais
> refusée par les builds récents ; ré-émettre les licences avec la nouvelle
> paire (`node scripts/rotate-rsa.cjs` documente la procédure).

## Emplacements recherchés pour la clé privée

1. Variable d'environnement `LICENSE_PRIVATE_KEY_PATH`
2. `<app>/license-generator/secrets/private.pem` (emplacement officiel)
3. `<repo>/license-generator/secrets/private.pem` (générateur placé dans le dépôt)
4. `<repo>/electron/keys/private.pem` (historique, avant rotation)

Si aucune n'existe, l'application affiche une erreur claire avec la commande
openssl pour créer la paire.

## Développement

```bash
cd license-generator
npm install
npm run dev        # build electron + vite (port 5174) + electron --dev
```

## Build

```bash
npm run build      # renderer (dist/) + main/preload (dist-electron/)
npm start          # lance l'app sur le build
```

## Utilisation

1. Saisir l'email du client.
2. Choisir **Lifetime** ou **Subscription**.
3. Pour une subscription : saisir une durée strictement positive en
   **minutes** ou en **jours**.
4. Cliquer **Générer la licence**, puis **Copier** ou **Sauvegarder…**.

### Mode test

Le lien « Remplir test@example.com / subscription / 1 minute » pré-remplit le
formulaire avec une licence d'essai expirant après 1 minute, pratique pour
vérifier dans My Creation : signature valide, licence acceptée, expiration
détectée.

## Format du JWT

Identique à `scripts/generate-license.cjs` :

| Champ       | Valeur                          |
| ----------- | ------------------------------- |
| `iss`       | `cursor-clone`                  |
| `sub`       | email du client                 |
| `licenseId` | `lic_<base36 timestamp><random>`|
| `type`      | `lifetime` ou `subscription`    |
| `product`   | `cursor-clone`                  |
| `version`   | optionnel                       |
| `exp`       | présent uniquement si subscription |
| algorithme  | RS256                           |

Vérification manuelle :

```bash
node -e "const jwt=require('jsonwebtoken');console.log(jwt.verify(require('fs').readFileSync('<token.txt>','utf8').trim(),require('fs').readFileSync('electron/keys/public.pem','utf8'),{algorithms:['RS256'],issuer:'cursor-clone'}))"
```
