/** Keyboard shortcut catalogue, shared by the handler and the Settings page. */

export interface ShortcutDefinition {
  id: string
  label: string
  /** Human-readable combination, already formatted for display. */
  keys: string
  group: 'Général' | 'Panneaux' | 'Édition' | 'Assistant'
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'palette', label: 'Palette de commandes', keys: 'Ctrl+P', group: 'Général' },
  { id: 'open-folder', label: 'Ouvrir un dossier', keys: 'Ctrl+O', group: 'Général' },
  { id: 'settings', label: 'Paramètres', keys: 'Ctrl+,', group: 'Général' },
  { id: 'home', label: 'Écran d’accueil', keys: 'Ctrl+H', group: 'Général' },
  { id: 'sidebar', label: 'Basculer la barre latérale', keys: 'Ctrl+B', group: 'Panneaux' },
  { id: 'terminal', label: 'Basculer le terminal', keys: 'Ctrl+`', group: 'Panneaux' },
  { id: 'preview', label: 'Aperçu du projet', keys: 'Ctrl+Maj+V', group: 'Panneaux' },
  { id: 'analysis', label: 'Analyse du projet', keys: 'Ctrl+Maj+A', group: 'Panneaux' },
  { id: 'explorer', label: 'Explorateur', keys: 'Ctrl+Maj+E', group: 'Panneaux' },
  { id: 'search', label: 'Recherche dans les fichiers', keys: 'Ctrl+Maj+F', group: 'Panneaux' },
  { id: 'git', label: 'Contrôle de source', keys: 'Ctrl+Maj+G', group: 'Panneaux' },
  { id: 'save', label: 'Enregistrer', keys: 'Ctrl+S', group: 'Édition' },
  { id: 'new-file', label: 'Nouveau fichier', keys: 'Ctrl+N', group: 'Édition' },
  { id: 'close-tab', label: 'Fermer l’onglet', keys: 'Ctrl+W', group: 'Édition' },
  { id: 'agent', label: 'Ouvrir l’assistant', keys: 'Ctrl+I', group: 'Assistant' },
  { id: 'new-chat', label: 'Nouvelle conversation', keys: 'Ctrl+Maj+N', group: 'Assistant' },
  { id: 'conversations', label: 'Liste des conversations', keys: 'Ctrl+Maj+C', group: 'Assistant' },
]

export function shortcutFor(id: string): string {
  return SHORTCUTS.find(shortcut => shortcut.id === id)?.keys ?? ''
}
