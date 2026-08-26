import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, BarChart3, Bot, Command, CreditCard, FilePlus, FolderOpen, History,
  Home, KeyRound, Languages, ListTodo, Monitor, Palette, PanelLeft, Play, Plus,
  Save, Settings, SquareTerminal, type LucideIcon,
} from 'lucide-react'
import type { Task } from '../shared/types'
import { Kbd } from './ui'
import { fade, modalIn, transitions } from '../animations'
import { cx } from './ui/cx'
import { shortcutFor } from '../shared/shortcuts'

interface CommandItem {
  id: string
  label: string
  hint: string
  group: string
  icon: LucideIcon
  shortcut?: string
  run: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  onOpenFolder: () => void
  onToggleTerminal: () => void
  onToggleSidebar: () => void
  onOpenSettings: () => void
  onOpenAgent: () => void
  onNewFile: () => void
  onNewChat: () => void
  onSave: () => void
  onOpenPreview: () => void
  onOpenAnalysis: () => void
  onStartPreview: () => void
  onOpenHome: () => void
  onCycleTheme: () => void
  onOpenTodo: () => void
  onOpenHistory: () => void
  onOpenLicense: () => void
  tasks: Task[]
}

/** Subsequence match: "opfo" finds "Ouvrir un dossier". */
function fuzzyScore(text: string, needle: string): number {
  if (needle.length === 0) return 1
  const lower = text.toLowerCase()
  if (lower.includes(needle)) return 100 - lower.indexOf(needle)

  let index = 0
  let score = 0
  for (const character of needle) {
    const found = lower.indexOf(character, index)
    if (found < 0) return 0
    score += found === index ? 3 : 1
    index = found + 1
  }
  return score
}

/**
 * Recherche globale + commandes (Ctrl+K, Ctrl+P conservé).
 * Sources locales uniquement : actions de l'app, tâches réelles, thèmes —
 * aucun appel IA pour une recherche instantanée.
 */
export function CommandPalette({
  open, onClose, onOpenFolder, onToggleTerminal, onToggleSidebar, onOpenSettings,
  onOpenAgent, onNewFile, onNewChat, onSave, onOpenPreview, onOpenAnalysis,
  onStartPreview, onOpenHome, onCycleTheme, onOpenTodo, onOpenHistory,
  onOpenLicense, tasks,
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<CommandItem[]>(() => [
    { id: 'new-task', label: 'Nouvelle tâche', hint: 'Ajouter à la Todo', group: 'Actions', icon: Plus, run: onOpenTodo },
    { id: 'open-folder', label: 'Ouvrir un dossier', hint: 'Choisir le dossier du projet', group: 'Actions', icon: FolderOpen, shortcut: shortcutFor('open-folder'), run: onOpenFolder },
    { id: 'new-file', label: 'Nouveau fichier', hint: 'Créer un éditeur sans titre', group: 'Actions', icon: FilePlus, shortcut: shortcutFor('new-file'), run: onNewFile },
    { id: 'save', label: 'Enregistrer', hint: 'Écrire le fichier actif sur le disque', group: 'Actions', icon: Save, shortcut: shortcutFor('save'), run: onSave },
    { id: 'home', label: 'Écran d’accueil', hint: 'Revenir à la page de démarrage', group: 'Navigation', icon: Home, shortcut: shortcutFor('home'), run: onOpenHome },
    { id: 'todo', label: 'Afficher les tâches', hint: 'Ouvrir la Todo', group: 'Navigation', icon: ListTodo, run: onOpenTodo },
    { id: 'history', label: 'Historique', hint: 'Ce qui s’est passé dans My Creation', group: 'Navigation', icon: History, run: onOpenHistory },
    { id: 'agent', label: 'Ouvrir l’assistant', hint: 'Mode Chat ou Agent', group: 'Assistant', icon: Bot, shortcut: shortcutFor('agent'), run: onOpenAgent },
    { id: 'new-chat', label: 'Nouvelle conversation', hint: 'Repartir de zéro avec l’assistant', group: 'Assistant', icon: Bot, shortcut: shortcutFor('new-chat'), run: onNewChat },
    { id: 'preview', label: 'Ouvrir l’aperçu', hint: 'Afficher le site dans l’onglet Aperçu', group: 'Panneaux', icon: Monitor, shortcut: shortcutFor('preview'), run: onOpenPreview },
    { id: 'preview-start', label: 'Démarrer l’aperçu', hint: 'Détecter le projet et lancer le serveur', group: 'Panneaux', icon: Play, run: onStartPreview },
    { id: 'analysis', label: 'Analyser le projet', hint: 'Statistiques, dépendances et architecture', group: 'Panneaux', icon: BarChart3, shortcut: shortcutFor('analysis'), run: onOpenAnalysis },
    { id: 'terminal', label: 'Basculer le terminal', hint: 'Afficher ou masquer le terminal', group: 'Panneaux', icon: SquareTerminal, shortcut: shortcutFor('terminal'), run: onToggleTerminal },
    { id: 'sidebar', label: 'Basculer la barre latérale', hint: 'Afficher ou masquer la colonne de gauche', group: 'Panneaux', icon: PanelLeft, shortcut: shortcutFor('sidebar'), run: onToggleSidebar },
    { id: 'theme', label: 'Changer de thème', hint: 'Parcourir les thèmes installés', group: 'Apparence', icon: Palette, run: onCycleTheme },
    { id: 'language', label: 'Changer la langue', hint: 'Français / English dans les paramètres', group: 'Paramètres', icon: Languages, run: () => { document.dispatchEvent(new CustomEvent('open-settings-section', { detail: 'general' })) } },
    { id: 'license', label: 'Activer une licence', hint: 'My Creation ou Gumroad', group: 'Paramètres', icon: KeyRound, run: onOpenLicense },
    { id: 'plan', label: 'Voir mon plan', hint: 'Plan, quota et permissions', group: 'Paramètres', icon: CreditCard, run: onOpenLicense },
    { id: 'settings', label: 'Ouvrir les paramètres', hint: 'Général, apparence, compte et données', group: 'Paramètres', icon: Settings, shortcut: shortcutFor('settings'), run: onOpenSettings },
  ], [
    onOpenFolder, onNewFile, onSave, onOpenHome, onOpenAgent, onNewChat, onOpenPreview,
    onStartPreview, onOpenAnalysis, onToggleTerminal, onToggleSidebar, onCycleTheme,
    onOpenSettings, onOpenTodo, onOpenHistory, onOpenLicense,
  ])

  /** Tâches réelles cherchées en priorité sur requête non vide. */
  const taskItems = useMemo<CommandItem[]>(() => {
    if (query.trim().length === 0) return []
    return tasks.filter(task => task.status !== 'completed').slice(0, 5).map(task => ({
      id: `task-${task.id}`,
      label: task.title,
      hint: task.status === 'in_progress' ? 'En cours' : task.status === 'blocked' ? `Bloquée${task.blockedReason ? ` — ${task.blockedReason}` : ''}` : 'À faire',
      group: 'Tâches',
      icon: ListTodo,
      run: onOpenTodo,
    }))
  }, [tasks, query, onOpenTodo])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const scoreOf = (label: string, hint: string): number =>
      Math.max(fuzzyScore(label, needle), fuzzyScore(hint, needle) * 0.6)

    const scoredTasks = taskItems
      .map(item => ({ item, score: scoreOf(item.label, item.hint) * 1.2 }))
      .filter(entry => entry.score > 0)
    const scoredCommands = commands
      .map(item => ({ item, score: scoreOf(item.label, item.hint) }))
      .filter(entry => entry.score > 0)

    return [...scoredTasks, ...scoredCommands]
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.item)
  }, [commands, taskItems, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setSelected(current => Math.min(current, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const execute = useCallback((item?: CommandItem) => {
    if (!item) return
    onClose()
    item.run()
  }, [onClose])

  // Group headers are only meaningful for the unfiltered list.
  const grouped = useMemo(() => {
    if (query.trim().length > 0) return [{ label: '', items: filtered }]
    const order: string[] = []
    const map = new Map<string, CommandItem[]>()
    for (const item of filtered) {
      if (!map.has(item.group)) {
        map.set(item.group, [])
        order.push(item.group)
      }
      map.get(item.group)?.push(item)
    }
    return order.map(label => ({ label, items: map.get(label) ?? [] }))
  }, [filtered, query])

  let cursor = -1

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-scrim"
          variants={fade}
          initial="hidden"
          animate="visible"
          exit="exit"
          onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
        >
          <motion.div
            className="command-palette"
            variants={modalIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label="Recherche globale"
          >
            <div className="palette__field">
              <Command size={16} />
              <input
                ref={inputRef}
                value={query}
                placeholder="Rechercher une action, une tâche…"
                aria-label="Rechercher"
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setSelected(current => Math.min(current + 1, filtered.length - 1))
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setSelected(current => Math.max(current - 1, 0))
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    execute(filtered[selected])
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onClose()
                  }
                }}
              />
              <Kbd>Échap</Kbd>
            </div>

            <div className="palette__list" ref={listRef}>
              {grouped.map(group => (
                <div className="palette__group" key={group.label || 'results'}>
                  {group.label && <div className="palette__group-head">{group.label}</div>}
                  {group.items.map(item => {
                    cursor += 1
                    const index = cursor
                    const active = index === selected
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-selected={active}
                        className={cx('palette__item', active && 'is-selected')}
                        onMouseEnter={() => setSelected(index)}
                        onClick={() => execute(item)}
                      >
                        <span className="palette__item-icon"><item.icon size={15} /></span>
                        <span className="palette__item-text">
                          <strong>{item.label}</strong>
                          <small>{item.hint}</small>
                        </span>
                        {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                        {active && (
                          <motion.span
                            className="palette__item-go"
                            initial={{ opacity: 0, x: -4 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={transitions.instant}
                          >
                            <ArrowRight size={13} />
                          </motion.span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="palette__empty">Aucun résultat</div>
              )}
            </div>

            <div className="palette__foot">
              <span><Kbd>↑</Kbd><Kbd>↓</Kbd> Naviguer</span>
              <span><Kbd>Entrée</Kbd> Exécuter</span>
              <span><Kbd>Échap</Kbd> Fermer</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
