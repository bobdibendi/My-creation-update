MY CREATION 1.0.0
==================

Editeur de code assiste par intelligence artificielle pour Windows 64 bits.


INSTALLATION
------------

1. Double-cliquez sur "My Creation Setup 1.0.0.exe".
2. Choisissez l'installation pour l'utilisateur courant (recommande, aucun
   droit administrateur requis) ou pour tous les utilisateurs.
3. Acceptez la licence, puis confirmez le dossier d'installation.
4. L'application se lance a la fin de l'installation.

Raccourcis crees : Menu Demarrer et Bureau.

Aucun autre logiciel n'est requis : Node.js, npm et le code source du projet
ne sont PAS necessaires. Tout est inclus dans l'installateur.


PREMIER DEMARRAGE
-----------------

1. Ouvrez un dossier de travail (bouton "Ouvrir un dossier" ou Ctrl+O).
2. Ouvrez les Parametres (icone engrenage, ou Ctrl+,).
3. Collez au moins une cle API :
     - Anthropic       (Claude)
     - OpenAI          (GPT)
     - Google          (Gemini)
     - Compatible      (tout service compatible OpenAI)
4. Choisissez un modele dans la barre de l'assistant.

Les cles sont chiffrees avec le trousseau Windows et stockees uniquement sur
votre machine, dans :
  %APPDATA%\My Creation\config\.api-keys.enc


FONCTIONS
---------

Chat      Conversation avec le modele, avec le contexte du fichier ouvert.
Agent     Execution autonome : lecture, ecriture, recherche, commandes shell.
          L'agent modifie les fichiers du dossier ouvert. Utilisez Git.
Editeur   Monaco (le moteur de VS Code), onglets, sauvegarde par Ctrl+S.
Preview   Detection automatique du projet, demarrage du serveur de dev ou
          d'un serveur statique, capture d'ecran automatique.
Terminal  Shell integre (cmd.exe), plusieurs sessions.
Explorer  Arborescence, creation, renommage, suppression.
Git       Statut, branches, commandes courantes.
Analyse   Statistiques du projet et graphe des dependances.


RACCOURCIS PRINCIPAUX
---------------------

Ctrl+O            Ouvrir un dossier
Ctrl+S            Enregistrer
Ctrl+P            Palette de commandes
Ctrl+Shift+F      Recherche dans le projet
Ctrl+B            Afficher / masquer la barre laterale
Ctrl+J            Afficher / masquer le panneau inferieur
Ctrl+,            Parametres
Ctrl+Shift+I      Outils de developpement


DESINSTALLATION
---------------

Parametres Windows > Applications > Applications installees > My Creation >
Desinstaller.

Vos cles API et vos preferences sont conservees dans %APPDATA%\My Creation.
Supprimez ce dossier manuellement pour effacer toute trace.


MISES A JOUR
------------

Installez simplement la version suivante par-dessus : l'installateur detecte
la version presente, la remplace et conserve vos parametres.


DONNEES ET RESEAU
-----------------

L'application ne contacte que les fournisseurs d'IA dont vous avez configure
la cle. Aucune telemetrie, aucun envoi de code vers un service tiers en
dehors des requetes que vous declenchez explicitement.

Le serveur de previsualisation ecoute uniquement sur 127.0.0.1 (boucle
locale) sur un port choisi par le systeme : il n'est pas accessible depuis le
reseau.


CONFIGURATION REQUISE
---------------------

Windows 10 ou 11, 64 bits
4 Go de RAM (8 Go recommandes)
~600 Mo d'espace disque
Connexion Internet pour les fonctions d'IA


LICENCE
-------

Voir le fichier LICENSE.
