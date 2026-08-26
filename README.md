# MY CREATION

IDE de bureau : Electron + React + TypeScript + Vite + Monaco + xterm.js, avec un
agent IA capable de lire, écrire et exécuter dans le dossier ouvert.

Version courante : **1.0.0** — distribuée sous forme d'installateur Windows.

## Installation (utilisateur final)

Un installateur prêt à l'emploi est produit par `npm run dist` :

```
release/My Creation Setup 1.0.0.exe
```

Double-clic, assistant d'installation, raccourcis Menu Démarrer et Bureau.
Ni Node.js, ni npm, ni le code source ne sont nécessaires sur la machine cible.

## Développement

```powershell
npm install
npm run build
npm start
```

Développement (Vite + rechargement à chaud) :

```powershell
npm run dev
```

Ajoutez ensuite une clé API via l'icône clé du panneau Assistant ou via
Paramètres. Les clés sont chiffrées avec `safeStorage` d'Electron et ne
redescendent jamais vers le renderer.

## Packaging

```powershell
npm run icons            # regénère les icônes et les images NSIS (Pillow requis)
npm run dist             # build + installateur NSIS dans release/
npm run test:package     # vérifie l'archive et lance l'app packagée hors du projet
npm run test:installer   # installe, vérifie, désinstalle réellement
npm run release          # typecheck + lint + dist + les deux vérifications
```

Sorties de `npm run dist` :

| Fichier | Rôle |
|---|---|
| `release/My Creation Setup 1.0.0.exe` | installateur à distribuer |
| `release/win-unpacked/` | application décompressée (test, portable) |
| `release/latest.yml` | métadonnées pour les mises à jour futures |
| `release/LICENSE`, `release/README.txt` | documents joints à la distribution |

La configuration vit dans le champ `build` de `package.json`. Les ressources
d'installation (`icon.ico`, `icon.png`, `icon.icns`, bandeaux NSIS, licence
affichée par l'assistant, `README.txt`) sont dans `build/` et sont générées par
`scripts/generate-icons.py`.

La signature de code n'est pas configurée : ajoutez `win.certificateFile` et
`win.certificatePassword` (ou les variables `CSC_LINK` / `CSC_KEY_PASSWORD`)
quand un certificat sera disponible. Rien d'autre ne change dans le build.

## Architecture

```
Utilisateur
  ↓  IPC (preload, contextBridge)
Agent (electron/agent/runtime.ts)      boucle : provider → outils → provider
  ↓
Provider (electron/providers/)         tool calling natif, streaming SSE
  ↓
Tool Registry (electron/agent/registry.ts)
  ↓
Outils : système de fichiers · terminal · analyse
  ↓
Workspace isolé (electron/agent/workspace.ts)
```

| Zone | Fichiers | Rôle |
|---|---|---|
| Main | `electron/main.ts` | fenêtre, handlers IPC, cycle de vie |
| Clés | `electron/keystore.ts` | stockage chiffré, migration du format hérité |
| Terminal | `electron/terminal.ts` | sessions shell interactives |
| Providers | `electron/providers/` | Anthropic, OpenAI, Google, Top Tools AI |
| Agent | `electron/agent/` | boucle agentique, outils, prompts, isolation |
| Preload | `electron/preload.ts` | pont typé et restreint |
| Renderer | `src/` | React, hooks, Monaco, xterm.js |

Le renderer tourne avec `contextIsolation: true`, `nodeIntegration: false` et
`sandbox: true`. Il n'a accès qu'aux méthodes exposées par le preload.

## Modes

**Chat** — conversation simple, sans outils. Le contenu du fichier ouvert peut
être joint à la demande (réglable dans Paramètres).

**Agent** — boucle autonome. Le modèle enchaîne les appels d'outils jusqu'à
pouvoir répondre : jusqu'à 60 étapes, sans limite de temps par étape. Une
requête peut donc durer aussi longtemps que le fournisseur répond ; le bouton
stop interrompt immédiatement.

## Outils de l'agent

| Outil | Effet |
|---|---|
| `listDirectory` | liste un dossier, avec option récursive |
| `readFile` | lit un fichier texte, avec plage de lignes optionnelle |
| `writeFile` | crée ou remplace un fichier |
| `editFile` | remplace une portion exacte de texte |
| `createDirectory` | crée un dossier et ses parents |
| `deleteFile` | supprime un fichier ou un dossier |
| `renameFile` | renomme sur place |
| `moveFile` | déplace vers un autre chemin |
| `pathExists` | teste l'existence et le type |
| `searchInFiles` | recherche texte ou expression régulière |
| `findFiles` | recherche par nom ou motif glob |
| `runCommand` | exécute une commande shell dans le workspace |
| `analyzeProject` | langages, arborescence, manifestes, scripts npm |
| `checkProject` | lance typecheck / lint / build / test et renvoie les erreurs |

Tous les chemins sont résolus dans le dossier ouvert. Les échappements
(`../`, chemins absolus, liens symboliques) sont refusés, ainsi que les
commandes destructrices au-delà du projet (formatage de disque, arrêt système,
suppression de racine).

## Scripts

| Commande | Description |
|---|---|
| `npm run dev` | Vite + Electron en mode développement |
| `npm run build` | build du renderer puis du processus principal |
| `npm run typecheck` | TypeScript strict sur les deux projets |
| `npm run lint` | ESLint |
| `npm start` | lance l'application compilée |
| `npm run icons` | regénère icônes et images d'installateur |
| `npm run dist` | build + installateur NSIS dans `release/` |
| `npm run dist:dir` | build packagé sans installateur (`release/win-unpacked`) |
| `npm test` | toutes les suites de tests |
| `npm run test:providers` | protocoles des fournisseurs (serveur HTTP local) |
| `npm run test:runtime` | boucle agentique (fournisseur scripté) |
| `npm run test:renderer` | React + preload dans une vraie fenêtre |
| `npm run test:app` | main + preload + renderer + IPC réels |
| `npm run test:agent` | agent réel sur un workspace jetable (consomme des tokens) |
| `npm run test:dev` | serveur Vite + renderer en mode développement |
| `npm run test:launch` | `npm start` et `npm run dev` de bout en bout |
| `npm run test:package` | archive, contenu et démarrage de l'app packagée |
| `npm run test:installer` | installation, raccourcis, registre, désinstallation |
| `npm run check` | typecheck + lint + build + tests + lancement |
| `npm run release` | typecheck + lint + dist + vérifications de packaging |

`test:providers`, `test:runtime`, `test:renderer` et `test:app` n'appellent
aucune API distante. `test:agent` exige une clé configurée et exécute de vraies
requêtes. `test:installer` installe réellement l'application pour l'utilisateur
courant (aucun droit administrateur), puis la désinstalle.

## Rotation des clés de licence (2026-08-26)

La clé privée historique ayant transité dans l'historique Git (commit
`fe6191f`, retiré dans `bff5c96`), la paire RS256 de licence a été **tournée**
avant toute commercialisation :

| Paire | Empreinte SHA-256 (clé publique) | Statut |
|---|---|---|
| Historique Git | `af056057…af493e01` | RETIRÉE — compromise par l'historique |
| Dernière paire locale pré-rotation | `103d8e11…ad515a030` | RETIRÉE — principe de précaution |
| **Paire active** | `c5fad623…b9c2112` | private.pem dans `license-generator/secrets/` (hors Git) |

Conséquences :
- les licences signées avec une ancienne clé sont **rejetées** par tout build
  récent : ré-émettre les licences à vendre avec le License Generator à jour ;
- les installations existantes doivent être mises à jour vers un build
  embarquant la nouvelle clé publique pour continuer à valider les nouvelles
  licences ;
- la procédure est rejouable : `node scripts/rotate-rsa.cjs --force` ;
- le contrôle d'absence de secrets dans les artefacts :
  `node scripts/security-scan.cjs`.

## Scripts

| Commande | Description |
|---|---|
| `node scripts/rotate-rsa.cjs [--force]` | rotation documentée de la paire RSA de licence |
| `node scripts/security-scan.cjs` | scan secrets des artefacts (dist, asar, installateur) |

## Fonctionnalités

- Fenêtre sans cadre, contrôles intégrés, instance unique
- Explorateur avec sous-dossiers, création, renommage, suppression
- Monaco : un modèle par fichier, minimap, coloration, `Ctrl+S`
- Terminal xterm.js démarré dans le dossier ouvert
- Recherche de contenu dans le projet
- Contrôle de source : état, branche, `add` et `commit`
- Palette de commandes (`Ctrl+P`), barre latérale (`Ctrl+B`), terminal
  (`Ctrl+``), assistant (`Ctrl+I`)
- Rafraîchissement automatique de l'arborescence et des onglets après une
  modification par l'agent
- Réponses de l'agent en français, avec journal des outils utilisés
