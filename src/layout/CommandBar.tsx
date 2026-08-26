import { motion } from 'framer-motion'
import {
  ChevronDown, FolderOpen, Home, PanelLeft, Plus, Search, Sparkles,
} from 'lucide-react'
import { IconButton, Kbd, Tooltip } from '../components/ui'
import { cx } from '../components/ui/cx'
import { shortcutFor } from '../shared/shortcuts'

interface Props {
  workspaceName: string
  sidebarVisible: boolean
  homeActive: boolean
  onOpenFolder: () => void
  onToggleSidebar: () => void
  onOpenPalette: () => void
  onOpenHome: () => void
  onNewChat: () => void
}

/**
 * Secondary bar under the title bar.
 *
 * `scripts/screenshot.cjs` clicks `.commandbar .toolbar-btn` first to open a
 * folder, so the workspace button must stay the first `.toolbar-btn` here.
 */
export function CommandBar({
  workspaceName, sidebarVisible, homeActive,
  onOpenFolder, onToggleSidebar, onOpenPalette, onOpenHome, onNewChat,
}: Props) {
  return (
    <div className="commandbar">
      <button type="button" className="toolbar-btn commandbar__workspace" onClick={onOpenFolder}>
        <FolderOpen size={13} />
        <span className="commandbar__workspace-name">{workspaceName || 'Ouvrir un dossier'}</span>
        <ChevronDown size={12} className="commandbar__chev" />
      </button>

      <Tooltip content="Barre latérale" shortcut={shortcutFor('sidebar')} side="bottom">
        <button
          type="button"
          className={cx('toolbar-btn', 'is-square', sidebarVisible && 'is-active')}
          onClick={onToggleSidebar}
          aria-label="Basculer la barre latérale"
          aria-pressed={sidebarVisible}
        >
          <PanelLeft size={14} />
        </button>
      </Tooltip>

      <Tooltip content="Écran d’accueil" shortcut={shortcutFor('home')} side="bottom">
        <button
          type="button"
          className={cx('toolbar-btn', 'is-square', homeActive && 'is-active')}
          onClick={onOpenHome}
          aria-label="Écran d’accueil"
          aria-pressed={homeActive}
        >
          <Home size={14} />
        </button>
      </Tooltip>

      <motion.button
        type="button"
        className="commandbar__search"
        onClick={onOpenPalette}
        whileHover={{ y: -1 }}
        whileTap={{ y: 0, scale: 0.995 }}
      >
        <Search size={13} />
        <span className="commandbar__search-text">Rechercher une commande, un fichier…</span>
        <Kbd>{shortcutFor('palette')}</Kbd>
      </motion.button>

      <div className="commandbar__actions">
        <Tooltip content="Nouvelle conversation" shortcut={shortcutFor('new-chat')} side="bottom">
          <button type="button" className="commandbar__new" onClick={onNewChat}>
            <Plus size={13} />
            <span>Nouveau chat</span>
          </button>
        </Tooltip>
        <IconButton
          label="Palette de commandes"
          icon={<Sparkles size={14} />}
          onClick={onOpenPalette}
        />
      </div>
    </div>
  )
}
