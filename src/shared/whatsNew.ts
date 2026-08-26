export interface WhatsNewEntry {
  version: string
  date: string
  sections: Array<{ title: 'new' | 'improved' | 'fixed'; items: string[] }>
}

/** Journal des nouveautés — affiché dans Paramètres → À propos et après mise à jour. */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.0.1',
    date: '2026-08',
    sections: [
      {
        title: 'fixed',
        items: [
          'Changement de mot de passe et d\'adresse e-mail depuis les paramètres',
          'Prix du plan PRO affiché à l\'identique de la boutique',
          'Libellé de consommation quotidien corrigé',
          'Mises à jour automatiques via GitHub Releases',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08',
    sections: [
      {
        title: 'new',
        items: [
          'Todo intelligente synchronisée en temps réel avec l\'assistant',
          'Nouvelle interface desktop premium et navigation latérale',
          'Support de l\'anglais (Français / English)',
          'Recherche globale Ctrl+K : actions, tâches et paramètres',
          'Historique des actions et annulation des tâches',
          'Enregistrement automatique avec indicateur d\'état',
          'Export et import des données locales',
        ],
      },
      {
        title: 'improved',
        items: [
          'La licence n\'est plus demandée au démarrage — le plan FREE est un mode complet',
          'Gestion du compte et de la licence réunie dans les paramètres',
          'Performances de navigation et de rendu',
        ],
      },
      {
        title: 'fixed',
        items: [
          'Stabilité de l\'activation des licences Gumroad hors-ligne',
        ],
      },
    ],
  },
]
