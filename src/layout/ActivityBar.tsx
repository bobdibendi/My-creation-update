import { motion } from 'framer-motion'
import {
  BarChart3, Bot, CreditCard, FileCode2, GitBranch, History, Home, ListTodo,
  MessagesSquare, Monitor, Package as PackageIcon, Plus, Search, Settings,
  SquareTerminal, UserRound, type LucideIcon,
} from 'lucide-react'
import type { DockTab, Panel } from '../shared/types'
import { Tooltip } from '../components/ui'
import { cx } from '../components/ui/cx'
import { useI18n } from '../i18n'
import type { MainView } from '../shared/types'
import { shortcutFor } from '../shared/shortcuts'

interface Props {
  activePanel: Panel
  view: MainView
  agentOpen: boolean
  dockOpen: boolean
  dockTab: DockTab
  collapsed: boolean
  planName: string
  canUpgrade: boolean
  onSelectPanel: (panel: Panel) => void
  onSelectView: (view: MainView) => void
  onToggleAgent: () => void
  onToggleDock: (tab: DockTab) => void
  onToggleCollapsed: () => void
  onOpenSettings: () => void
  onNewChat: () => void
  onUpgrade: () => void
}

interface NavItem {
  id: string
  icon: LucideIcon
  labelKey: string
  shortcut?: string
  active: boolean
  run(): void
}

/**
 * Navigation principale étiquetée — style logiciel desktop.
 *
 * La classe `activitybar` et le bouton « Assistant IA » sont des contrats de
 * tests (`test-renderer.cjs`, `test-free-flow.cjs`) : ne pas renommer.
 */
export function ActivityBar({
  activePanel, view, agentOpen, dockOpen, dockTab, collapsed, planName, canUpgrade,
  onSelectPanel, onSelectView, onToggleAgent, onToggleDock, onToggleCollapsed,
  onOpenSettings, onNewChat, onUpgrade,
}: Props) {
  const { t } = useI18n()

  const mainItems: NavItem[] = [
    {
      id: 'home', icon: Home, labelKey: 'sidebar.home', shortcut: shortcutFor('home'),
      active: view === 'home', run: () => onSelectView('home'),
    },
    {
      id: 'create', icon: Plus, labelKey: 'sidebar.create',
      active: false, run: () => onNewChat(),
    },
    {
      id: 'todo', icon: ListTodo, labelKey: 'sidebar.todo',
      active: view === 'todo', run: () => onSelectView('todo'),
    },
    {
      id: 'history', icon: History, labelKey: 'sidebar.history',
      active: view === 'history', run: () => onSelectView('history'),
    },
  ]

  const workspaceItems: NavItem[] = [
    {
      id: 'explorer', icon: FileCode2, labelKey: 'sidebar.files', shortcut: shortcutFor('explorer'),
      active: activePanel === 'explorer', run: () => onSelectPanel('explorer'),
    },
    {
      id: 'search', icon: Search, labelKey: 'sidebar.searchPanel', shortcut: shortcutFor('search'),
      active: activePanel === 'search', run: () => onSelectPanel('search'),
    },
    {
      id: 'git', icon: GitBranch, labelKey: 'sidebar.git', shortcut: shortcutFor('git'),
      active: activePanel === 'git', run: () => onSelectPanel('git'),
    },
    {
      id: 'chats', icon: MessagesSquare, labelKey: 'sidebar.chats', shortcut: shortcutFor('conversations'),
      active: activePanel === 'chats', run: () => onSelectPanel('chats'),
    },
    {
      id: 'package', icon: PackageIcon, labelKey: 'sidebar.package',
      active: activePanel === 'package', run: () => onSelectPanel('package'),
    },
    {
      id: 'subscription', icon: CreditCard, labelKey: 'sidebar.subscription',
      active: activePanel === 'subscription', run: () => onSelectPanel('subscription'),
    },
    {
      id: 'account', icon: UserRound, labelKey: 'sidebar.account',
      active: activePanel === 'account', run: () => onSelectPanel('account'),
    },
  ]

  const dockItems: Array<{ id: DockTab; icon: LucideIcon; labelKey: string; shortcut?: string }> = [
    { id: 'terminal', icon: SquareTerminal, labelKey: 'statusbar.terminal', shortcut: shortcutFor('terminal') },
    { id: 'preview', icon: Monitor, labelKey: 'statusbar.preview', shortcut: shortcutFor('preview') },
    { id: 'analysis', icon: BarChart3, labelKey: 'statusbar.analysis', shortcut: shortcutFor('analysis') },
  ]

  const renderItem = (item: NavItem) => (
    <Tooltip key={item.id} content={t(item.labelKey)} side="right" shortcut={item.shortcut || undefined}>
      <button
        type="button"
        className={cx('rail-btn', item.active && 'is-active')}
        title={t(item.labelKey)}
        aria-label={t(item.labelKey)}
        aria-pressed={item.active}
        onClick={item.run}
      >
        <item.icon size={17} />
        {!collapsed && <span className="rail-btn__label">{t(item.labelKey)}</span>}
        {item.active && (
          <motion.span
            layoutId="rail-marker"
            className="rail-btn__marker"
            transition={{ type: 'spring', stiffness: 480, damping: 34 }}
          />
        )}
      </button>
    </Tooltip>
  )

  return (
    <nav className={cx('activitybar', collapsed && 'is-collapsed')} aria-label="Navigation principale">
      <div className="rail-brand-row">
        <span className="rail-brand" aria-label="My Creation">
          <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden>
            <path d="M12 2.6 21.4 12 12 21.4 2.6 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3.1" fill="currentColor" />
          </svg>
        </span>
        {!collapsed && (
          <>
            <span className="rail-brand-name">MY CREATION</span>
            <button
              type="button"
              className="rail-collapse"
              title={t('sidebar.collapse')}
              aria-label={t('sidebar.collapse')}
              onClick={onToggleCollapsed}
            >
              ‹
            </button>
          </>
        )}
      </div>

      {collapsed && (
        <Tooltip content={t('sidebar.expand')} side="right">
          <button
            type="button"
            className="rail-btn rail-btn--slim"
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
            onClick={onToggleCollapsed}
          >
            ›
          </button>
        </Tooltip>
      )}

      <div className="rail-group">{mainItems.map(renderItem)}</div>

      <div className="rail-group rail-group--section">
        {!collapsed && <span className="rail-section-title">{t('sidebar.workspace')}</span>}
        {workspaceItems.map(renderItem)}
      </div>

      <div className="rail-group">
        <Tooltip content="Assistant IA" side="right" shortcut={shortcutFor('agent')}>
          <button
            type="button"
            className={cx('rail-btn', 'rail-btn--accent', agentOpen && 'is-active')}
            title="Assistant IA"
            aria-label="Assistant IA"
            aria-pressed={agentOpen}
            onClick={onToggleAgent}
          >
            <Bot size={18} />
            {!collapsed && <span className="rail-btn__label">Assistant IA</span>}
          </button>
        </Tooltip>
      </div>

      <div className="rail-group rail-group--section">
        {dockItems.map(({ id, icon: Icon, labelKey, shortcut }) => {
          const active = dockOpen && dockTab === id
          return (
            <Tooltip key={id} content={t(labelKey)} side="right" shortcut={shortcut || undefined}>
              <button
                type="button"
                className={cx('rail-btn', active && 'is-active')}
                title={t(labelKey)}
                aria-label={t(labelKey)}
                aria-pressed={active}
                onClick={() => onToggleDock(id)}
              >
                <Icon size={16} />
                {!collapsed && <span className="rail-btn__label">{t(labelKey)}</span>}
              </button>
            </Tooltip>
          )
        })}
      </div>

      <div className="rail-spacer" />

      <div className="rail-group rail-plan">
        {canUpgrade ? (
          <Tooltip content={t('license.upgradePro')} side="right">
            <button
              type="button"
              className="rail-upgrade"
              onClick={onUpgrade}
              title={t('license.upgradePro')}
            >
              <CreditCard size={14} aria-hidden />
              {!collapsed && <span>{planName}</span>}
              {!collapsed && <em>{t('sidebar.upgradeToPro')}</em>}
            </button>
          </Tooltip>
        ) : (
          <div className={cx('rail-plan-badge', planName !== 'FREE' && 'is-pro')}>
            <CreditCard size={13} aria-hidden />
            {!collapsed && <span>{planName}</span>}
          </div>
        )}
      </div>

      <div className="rail-group">
        <Tooltip content={t('common.settings')} side="right" shortcut={shortcutFor('settings')}>
          <button
            type="button"
            className="rail-btn"
            title={t('common.settings')}
            aria-label={t('common.settings')}
            onClick={onOpenSettings}
          >
            <Settings size={17} />
            {!collapsed && <span className="rail-btn__label">{t('common.settings')}</span>}
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
