# Provisionnement administrateur — MY CREATION

À destination de **l'administrateur** qui déploie My Creation.
L'utilisateur final n'a jamais rien à configurer : Kim Pro et Ox Alpha Free
fonctionnent automatiquement une fois l'installation provisionnée.

## 1. Clés IA (backend Top-Tools-AI / OpenCode-Zen)

Au premier démarrage de l'application installée, My Creation importe
automatiquement :

```
%APPDATA%\My Creation\admin-keys.json
```

Contenu :

```json
{
  "tools": "<clé Top Tools AI>",
  "opencode-zen": "<clé OpenCode Zen (optionnelle : le endpoint répond aussi sans clé)>"
}
```

Procédure :
1. Installer My Creation.
2. Lancer l'application **une fois en tant qu'administrateur** ou déposer le
   fichier via votre outil de déploiement (GPO/Intune/script).
3. Au démarrage suivant, les clés sont re-chiffrées dans le profil utilisateur
   via `safeStorage` et le fichier est archivé en `admin-keys.json.imported`.

Règles de sécurité :
- jamais dans `src/`, `app.asar`, `package.json` ou Git ;
- jamais affichée dans l'interface ni écrite dans les logs (seules des
  empreintes non réversibles apparaissent côté console main) ;
- plusieurs clés Top-Tools-AI : utiliser la variable d'environnement
  `TOP_TOOLS_AI_API_KEYS` (`k1,k2,…`) côté machine administrée si besoin de
  pool étendu.

Si le fichier est absent ou invalide, les modèles intégrés affichent :
« …cette installation n'a pas encore été activée par votre administrateur ».

## 2. Licences

Le seul endroit où créer des licences My Creation est le **License Generator**
(outil admin séparé) : niveau d'adhésion (Free / Pro / Pro Ultimate) × durée
(Lifetime → 365 jours), signées RS256 avec `private.pem` qui ne quitte jamais
le poste administrateur. L'utilisateur colle simplement le JWT fourni dans
l'écran d'activation.

Aucun achat n'est proposé depuis l'application : les fournisseurs IA
(Top-Tools-AI, OpenCode) sont des prestataires techniques invisibles.
