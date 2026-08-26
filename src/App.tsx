import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Braces, Play } from 'lucide-react'
import { useEditor } from './hooks/useEditor'
import { useFileSystem } from './hooks/useFileSystem'
import { useSearch, type SearchResult } from './hooks/useSearch'
import { usePanel } from './hooks/usePanel'
import { useSettings } from './hooks/useSettings'
import { useGitStatus } from './hooks/useGitStatus'
import { usePreview } from './hooks/usePreview'
import { useProjectAnalysis } from './hooks/useProjectAnalysis'
import { useConversations } from './hooks/useConversations'
import { useLayout } from './hooks/useLayout'
import { useAuth } from './hooks/useAuth'
import { useTasks } from './hooks/useTasks'
import { useUpdates } from './hooks/useUpdates'
import { AppShell, ActivityBar, CommandBar, Sidebar, Statusbar, Titlebar } from './layout'
import { Explorer } from './components/Explorer'
import { SearchPanel } from './components/SearchPanel'
import { SourceControl } from './components/SourceControl'
import { ConversationList } from './components/ConversationList'
import { AssistantPanel } from './components/AssistantPanel'
import { EditorTabs } from './components/EditorTabs'
import { DockPanel } from './components/DockPanel'
import { HomeScreen } from './components/HomeScreen'
import { TodoPage } from './components/TodoPage'
import { HistoryPage } from './components/HistoryPage'
import { SettingsPanel } from './components/SettingsPanel'
import { CommandPalette } from './components/CommandPalette'
import { SplashScreen } from './components/SplashScreen'
import { LicenseScreen } from './components/LicenseScreen'
import { Onboarding } from './components/Onboarding'
import { PackagePanel } from './components/PackagePanel'
import { SubscriptionPanel } from './components/SubscriptionPanel'
import { AccountPanel } from './components/AccountPanel'
import { UpdateModal } from './components/UpdateModal'
import { EmptyState, useToast } from './components/ui'
import { THEMES, useTheme } from './theme'
import { riseIn } from './animations'
import type { AgentMode, DockTab, MainView, Panel } from './shared/types'

const SPLASH_MS = 1150
const RECENT_PROJECTS_KEY = 'my-creation.recent-projects'

function readRecentProjects(): Array<{ path: string; name: string; lastOpenedAt: number }> {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(parsed) ? parsed.slice(0, 6) : []
  } catch {
    return []
  }
}

function rememberProject(path: string): void {
  if (!path) return
  const name = path.split(/[\\/]/).pop() ?? path
  const next = [
    { path, name, lastOpenedAt: Date.now() },
    ...readRecentProjects().filter(entry => entry.path !== path),
  ].slice(0, 6)
  try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)) } catch { /* best effort */ }
}

function branchNameOf(status: string): string | null {
  const line = status.split(/\r?\n/).find(entry => entry.startsWith('##'))
  return line ? line.replace(/^##\s*/, '').split('...')[0] : null
}

function changeCountOf(status: string): number {
  return status.split(/\r?\n/).filter(line => line.length > 0 && !line.startsWith('##')).length
}

/** Compact token formatting for toast copy. */
function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export default function App() {
  const auth = useAuth()
  const fs = useFileSystem()
  const editor = useEditor()
  const search = useSearch()
  const panel = usePanel()
  const layout = useLayout()
  const settings = useSettings()
  const conversations = useConversations()
  const appearance = useTheme()
  const toast = useToast()
  const tasksApi = useTasks(auth.sessionToken)
  /** Mises à jour GitHub Releases (vérifiées au boot selon le réglage). */
  const updates = useUpdates({ autoCheck: settings.settings.checkUpdates !== false })
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // « Plus tard » ne doit jamais masquer l'étape finale : la modale revient
  // dès que le téléchargement est prêt.
  useEffect(() => {
    if (updates.phase === 'downloaded') setUpdateDismissed(false)
  }, [updates.phase])

  /** Après connexion depuis l'écran d'accueil : proposer l'activation une fois. */
  const [licenseIntent, setLicenseIntent] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)

  const { gitStatus, repository, refreshGitStatus } = useGitStatus(fs.folderPath)
  const preview = usePreview(fs.folderPath)
  const analysis = useProjectAnalysis(
    fs.folderPath,
    (panel.dockOpen && panel.dockTab === 'analysis') || panel.homeVisible,
  )

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [splashVisible, setSplashVisible] = useState(settings.settings.showSplash)
  const [pendingPrompt, setPendingPrompt] = useState('')
  const [mode, setMode] = useState<AgentMode>(settings.settings.defaultMode)
  /** Nom du plan effectif (FREE/PRO/PRO ULTIMATE), poussé par le main. */
  const [planBadge, setPlanBadge] = useState('FREE')

  const rootName = fs.folderPath ? fs.folderPath.split(/[\\/]/).pop() ?? '' : ''
  const branch = repository ? branchNameOf(gitStatus) : null
  const changeCount = repository ? changeCountOf(gitStatus) : 0
  const activeTab = useMemo(
    () => editor.tabs.find(tab => tab.path === editor.activePath),
    [editor.tabs, editor.activePath],
  )
  const recentProjects = useMemo(readRecentProjects, [fs.folderPath])

  // ─── Boot ──────────────────────────────────────────
  useEffect(() => {
    if (!splashVisible) return
    const timer = window.setTimeout(() => setSplashVisible(false), SPLASH_MS)
    return () => window.clearTimeout(timer)
  }, [splashVisible])

  // Applied once at startup: a later preference change must not force the
  // panel open while the user is working.
  const autoOpenApplied = useRef(false)
  useEffect(() => {
    if (autoOpenApplied.current) return
    autoOpenApplied.current = true
    if (settings.settings.autoOpenAgent) panel.openAgent()
  }, [settings.settings.autoOpenAgent, panel])

  // ─── Cross-cutting effects ─────────────────────────
  useEffect(() => {
    const handler = () => {
      void fs.refreshTree()
      void editor.reloadFromDisk()
      void refreshGitStatus()
    }
    document.addEventListener('workspace-files-changed', handler)
    return () => document.removeEventListener('workspace-files-changed', handler)
  }, [fs.refreshTree, editor.reloadFromDisk, refreshGitStatus])

  useEffect(() => {
    if (!settings.settings.autoRevealPreview) return
    if (preview.status.state !== 'running' || !preview.status.url) return
    panel.selectDockTab('preview')
  }, [
    preview.status.state, preview.status.url,
    panel.selectDockTab, settings.settings.autoRevealPreview,
  ])

  useEffect(() => {
    const handler = () => settings.openSettings()
    document.addEventListener('open-settings', handler)
    return () => document.removeEventListener('open-settings', handler)
  }, [settings.openSettings])

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  // plan:update : activation de licence, changement de profil ou expiration.
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge || !auth.sessionToken) {
      setPlanBadge('FREE')
      return
    }
    const refresh = () => {
      void bridge.permissions.get(auth.sessionToken!).then(info => setPlanBadge(info.planName)).catch(() => undefined)
      void auth.refreshLicense()
      document.dispatchEvent(new CustomEvent('api-keys-changed'))
    }
    const dispose = bridge.planEvents.onUpdate(refresh)
    void bridge.permissions.get(auth.sessionToken).then(info => setPlanBadge(info.planName)).catch(() => undefined)
    return dispose
  }, [auth.sessionToken])

  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge) return
    const dispose = bridge.subscription.onAlert(({ threshold, summary }) => {
      if (threshold >= 100) {
        toast.notify({
          title: 'Quota quotidien atteint.',
          description: `Prochain reset : ${new Date(summary.nextResetAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.`,
          tone: 'danger',
        })
      } else {
        toast.notify({
          title: `Vous avez utilisé ${threshold}% de votre quota quotidien.`,
          description: `Plan ${summary.plan.name} — ${formatCompact(summary.totalTokens)} tokens utilisés aujourd’hui.`,
          tone: threshold >= 90 ? 'warning' : 'accent',
        })
      }
    })
    return dispose
  }, [toast])

  // ─── Actions ───────────────────────────────────────
  const startNewChat = useCallback(() => {
    conversations.startNew(mode)
    panel.openAgent()
  }, [conversations, mode, panel])

  const promptAssistant = useCallback((prompt: string) => {
    panel.openAgent()
    setPendingPrompt(prompt)
  }, [panel])

  const cycleTheme = useCallback(() => {
    const index = THEMES.findIndex(theme => theme.id === appearance.themeId)
    const next = THEMES[(index + 1) % THEMES.length]
    appearance.setThemeId(next.id)
  }, [appearance])

  const openFolder = useCallback(() => {
    void (async () => {
      const opened = await fs.openFolder()
      if (opened) rememberProject(opened)
    })()
  }, [fs])

  const openRecentProject = useCallback((path: string): void => {
    void fs.openFolderPath(path)
    rememberProject(path)
  }, [fs])

  const selectView = useCallback((next: MainView): void => {
    panel.showView(next)
  }, [panel])

  const openSettingsTo = useCallback((section?: string): void => {
    settings.openSettings()
    if (section) {
      window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('open-settings-section', { detail: section }))
      }, 30)
    }
  }, [settings])

  const runSearch = useCallback(() => {
    void search.runSearch(fs.folderPath)
  }, [search, fs.folderPath])

  const clearConversation = useCallback(() => {
    if (!conversations.activeId) return
    conversations.setEntries(conversations.activeId, () => [])
  }, [conversations])

  const setConversationEntries = useCallback(
    (update: Parameters<typeof conversations.setEntries>[1]) => {
      const id = conversations.ensureActive(mode)
      if (id) conversations.setEntries(id, update)
    },
    [conversations, mode],
  )

  const changeMode = useCallback((next: AgentMode) => {
    setMode(next)
    if (conversations.activeId) conversations.setMode(conversations.activeId, next)
  }, [conversations])

  const selectPanel = useCallback((next: Panel) => {
    panel.togglePanel(next)
  }, [panel])

  const toggleDock = useCallback((tab: DockTab) => {
    panel.toggleDock(tab)
  }, [panel])

  // ─── Keyboard ──────────────────────────────────────
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey
      if (!meta) return
      const key = event.key.toLowerCase()

      if (event.shiftKey) {
        switch (key) {
          case 'v':
            event.preventDefault()
            panel.toggleDock('preview')
            return
          case 'a':
            event.preventDefault()
            panel.toggleDock('analysis')
            return
          case 'e':
            event.preventDefault()
            panel.togglePanel('explorer')
            return
          case 'f':
            event.preventDefault()
            panel.togglePanel('search')
            return
          case 'g':
            event.preventDefault()
            panel.togglePanel('git')
            return
          case 'c':
            event.preventDefault()
            panel.togglePanel('chats')
            return
          case 'n':
            event.preventDefault()
            startNewChat()
            return
          default:
            return
        }
      }

      switch (key) {
        case 'k':
        case 'p':
          event.preventDefault()
          setPaletteOpen(true)
          break
        case 'b':
          event.preventDefault()
          layout.toggleSidebar()
          break
        case 'i':
          event.preventDefault()
          panel.toggleAgent()
          break
        case 'o':
          event.preventDefault()
          openFolder()
          break
        case 'h':
          event.preventDefault()
          panel.showHome()
          break
        case 'n':
          event.preventDefault()
          editor.newUntitledFile()
          panel.hideHome()
          break
        case 'w':
          if (editor.activePath) {
            event.preventDefault()
            editor.closeTab(editor.activePath)
          }
          break
        case ',':
          event.preventDefault()
          settings.openSettings()
          break
        case '`':
          event.preventDefault()
          panel.toggleTerminal()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [panel, layout, editor, settings, openFolder, startNewChat])

  // ─── Autosave ──────────────────────────────────────
  const handleEditorChange = useCallback((path: string, content: string | undefined): void => {
    editor.updateContent(path, content)
    editor.scheduleAutosave(settings.settings.autosave ?? true)
  }, [editor, settings.settings.autosave])

  // ─── Sidebar selection ─────────────────────────────
  const sidebar = useMemo(() => {
    if (layout.sidebarCollapsed || panel.activePanel === '') return null

    switch (panel.activePanel) {
      case 'chats':
        return (
          <ConversationList
            groups={conversations.groups}
            activeId={conversations.activeId}
            query={conversations.query}
            total={conversations.conversations.length}
            onQueryChange={conversations.setQuery}
            onSelect={id => {
              conversations.select(id)
              panel.openAgent()
            }}
            onNew={startNewChat}
            onRename={conversations.rename}
            onRemove={conversations.remove}
            onClearAll={conversations.clearAll}
          />
        )
      case 'explorer':
        return (
          <Explorer
            folderPath={fs.folderPath}
            rootName={rootName}
            files={fs.files}
            expanded={fs.expanded}
            tabs={editor.tabs}
            activePath={editor.activePath}
            dirContents={fs.dirContents}
            onToggleDir={fs.toggleDir}
            onOpenFile={node => {
              void editor.openFile(node)
              panel.hideHome()
            }}
            onSelectTab={path => {
              editor.selectTab(path)
              panel.hideHome()
            }}
            onCloseTab={editor.closeTab}
            onOpenFolder={openFolder}
            onRefresh={() => void fs.refreshTree()}
            onListDir={fs.listDir}
            onCreateEntry={fs.createEntry}
            onDeleteEntry={fs.deleteEntry}
            onRenameEntry={fs.renameEntry}
          />
        )
      case 'search':
        return (
          <SearchPanel
            folderPath={fs.folderPath}
            query={search.query}
            results={search.results}
            searching={search.searching}
            onQueryChange={search.setQuery}
            onRun={runSearch}
            onOpenResult={(result: SearchResult) => {
              void editor.openPath(result.path)
              panel.hideHome()
            }}
          />
        )
      case 'git':
        return (
          <SourceControl
            cwd={fs.folderPath}
            statusSignal={gitStatus}
            onChanged={refreshGitStatus}
          />
        )
      case 'run':
        return (
          <Sidebar title="Exécuter et déboguer">
            <EmptyState
              icon={<Play size={22} />}
              title="Exécution"
              description="Lance l’aperçu du projet ou utilise le terminal intégré pour les scripts."
              action={
                <button type="button" className="sidebar__cta" onClick={() => panel.selectDockTab('preview')}>
                  Démarrer l’aperçu
                </button>
              }
            />
          </Sidebar>
        )
      case 'extensions':
        return (
          <Sidebar title="Extensions">
            <EmptyState
              icon={<Braces size={22} />}
              title="Extensions"
              description="Aucune extension installée. Cette version ne charge pas de greffons tiers."
            />
          </Sidebar>
        )
      case 'package':
        return (
          <PackagePanel
            workspace={fs.folderPath}
            sessionToken={auth.sessionToken}
          />
        )
      case 'subscription':
        return (
          <SubscriptionPanel
            sessionToken={auth.sessionToken}
            licenseActive={auth.licenseActive}
            licenseType={auth.licenseType}
            licenseExpiresAt={auth.licenseExpiresAt}
            licenseSource={auth.licenseSource}
            onActivateLicense={auth.activateLicense}
            onActivateGumroadLicense={auth.activateGumroadLicense}
            onDeactivateLicense={() => auth.deactivateLicense()}
          />
        )
      case 'account':
        return (
          <AccountPanel
            sessionToken={auth.sessionToken}
            user={auth.user ? { id: auth.user.id, name: auth.user.name, email: auth.user.email, createdAt: auth.user.createdAt } : null}
            licenseActive={auth.licenseActive}
            licenseType={auth.licenseType}
            licenseExpiresAt={auth.licenseExpiresAt}
            planName={planBadge}
            onUpdateProfile={auth.updateProfile}
            onChangePassword={auth.changePassword}
            onLogout={() => auth.logout()}
          />
        )
      default:
        return null
    }
  }, [
    layout.sidebarCollapsed, panel, conversations, startNewChat, fs, rootName,
    editor, openFolder, search, runSearch, gitStatus,
    refreshGitStatus, auth.sessionToken,
    auth.user, auth.updateProfile,
    auth.changePassword, planBadge,
    auth.licenseActive, auth.licenseType, auth.licenseExpiresAt, auth.licenseSource,
    auth.activateLicense, auth.activateGumroadLicense, auth.deactivateLicense,
  ])

  const showTodo = panel.view === 'todo'
  const showHistory = panel.view === 'history'
  const showEditorArea = !showTodo && !showHistory && !(panel.view === 'home' && true)

  // ── Boot chain ───────────────────────────────────────
  // splash -> écran d'accueil (auth) -> app.
  // Sans session Supabase valide, l'utilisateur n'entre JAMAIS directement
  // dans l'application : il passe par la connexion ou la création de compte.
  if (auth.loading) {
    return <SplashScreen visible />
  }

  if (!auth.user) {
    return (
      <>
        <Onboarding
          login={async (email, password) => {
            const result = await auth.login(email, password)
            if (result.success) setLicenseIntent(true)
            return result
          }}
          register={async (email, password, name) => {
            const result = await auth.register(email, password, name)
            if (result.success) setLicenseIntent(true)
            return result
          }}
          notice={auth.confirmationNotice}
        />
        <SplashScreen visible={splashVisible} />
      </>
    )
  }

  // Compte connecté juste après l'écran d'accueil : écran d'activation
  // proposé UNE FOIS, contournable — jamais bloquant (FREE reste accessible).
  if (auth.user && licenseIntent && !auth.licenseActive) {
    return (
      <>
        <LicenseScreen
          userName={auth.user.name}
          onActivate={auth.activateLicense}
          onActivateGumroad={auth.activateGumroadLicense}
          onLogout={async () => {
            setLicenseIntent(false)
            await auth.logout()
          }}
          onSkip={() => setLicenseIntent(false)}
        />
        <SplashScreen visible={splashVisible} />
      </>
    )
  }

  return (
    <>
      <AppShell
        titlebar={
          <Titlebar
            workspaceName={rootName}
            branch={branch}
            agentBusy={false}
            planName={auth.user ? planBadge : 'FREE'}
            canUpgrade={planBadge === 'FREE'}
            userName={auth.user?.name ?? null}
            userEmail={auth.user?.email ?? null}
            online={online}
            onOpenAccount={() => openSettingsTo('account')}
            onOpenLicense={() => openSettingsTo('license')}
            onOpenSettings={settings.openSettings}
            onUpgrade={() => openSettingsTo('license')}
            onLogout={() => { void auth.logout() }}
          />
        }
        commandbar={
          <CommandBar
            workspaceName={rootName}
            sidebarVisible={!layout.sidebarCollapsed && panel.activePanel !== ''}
            homeActive={panel.view === 'home'}
            onOpenFolder={openFolder}
            onToggleSidebar={layout.toggleSidebar}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenHome={panel.showHome}
            onNewChat={startNewChat}
          />
        }
        rail={
          <ActivityBar
            activePanel={panel.activePanel}
            view={panel.view}
            agentOpen={panel.agentOpen}
            dockOpen={panel.dockOpen}
            dockTab={panel.dockTab}
            collapsed={layout.navCollapsed}
            planName={auth.user ? planBadge : 'FREE'}
            canUpgrade={planBadge === 'FREE'}
            onSelectPanel={selectPanel}
            onSelectView={selectView}
            onToggleAgent={panel.toggleAgent}
            onToggleDock={toggleDock}
            onToggleCollapsed={layout.toggleNavCollapsed}
            onOpenSettings={settings.openSettings}
            onNewChat={startNewChat}
            onUpgrade={() => openSettingsTo('license')}
          />
        }
        sidebar={sidebar}
        sidebarWidth={layout.sidebarWidth}
        onResizeSidebar={layout.resizeSidebar}
        main={
          <AnimatePresence mode="wait">
            {showTodo ? (
              <motion.div key="todo" className="workspace__main" variants={riseIn} initial="hidden" animate="visible" exit="exit">
                <TodoPage tasks={tasksApi} />
              </motion.div>
            ) : showHistory ? (
              <motion.div key="history" className="workspace__main" variants={riseIn} initial="hidden" animate="visible" exit="exit">
                <HistoryPage sessionToken={auth.sessionToken} />
              </motion.div>
            ) : (panel.view === 'home' || editor.tabs.length === 0) ? (
              <motion.div
                key="home"
                className="workspace__main"
                variants={riseIn}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <HomeScreen
                  userName={settings.settings.userName || auth.user?.name || 'My Creation'}
                  workspaceName={rootName}
                  workspacePath={fs.folderPath}
                  analysis={analysis.analysis}
                  analysisLoading={analysis.loading}
                  recentFiles={editor.recent}
                  recentProjects={recentProjects}
                  todoTasks={tasksApi.tasks}
                  onPrompt={promptAssistant}
                  onCreate={startNewChat}
                  onOpenFolder={openFolder}
                  onOpenRecentProject={openRecentProject}
                  onOpenTerminal={() => panel.selectDockTab('terminal')}
                  onOpenAnalysis={() => panel.selectDockTab('analysis')}
                  onOpenFile={path => {
                    void editor.openPath(path)
                    panel.hideHome()
                  }}
                  onOpenTodo={() => selectView('todo')}
                />
              </motion.div>
            ) : showEditorArea ? (
              <motion.div
                key="editor"
                className="workspace__main"
                variants={riseIn}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <EditorTabs
                  tabs={editor.tabs}
                  activePath={editor.activePath}
                  onSelectTab={editor.selectTab}
                  onCloseTab={editor.closeTab}
                  onCloseOthers={editor.closeOthers}
                  onCloseAll={editor.closeAll}
                  onChangeContent={handleEditorChange}
                  onSave={editor.saveFile}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        }
        dock={
          <DockPanel
            open={panel.dockOpen}
            activeTab={panel.dockTab}
            workspace={fs.folderPath}
            height={layout.dockHeight}
            preview={preview}
            analysis={analysis}
            onSelectTab={panel.selectDockTab}
            onResize={layout.resizeDock}
            onClose={panel.closeDock}
          />
        }
        agent={
          panel.agentOpen ? (
            <AssistantPanel
              workspace={fs.folderPath}
              activeFilePath={activeTab && !activeTab.untitled ? activeTab.path : ''}
              activeFileContent={activeTab?.content ?? ''}
              sendFileContents={settings.settings.sendFileContents}
              sessionToken={auth.sessionToken}
              mode={mode}
              onModeChange={changeMode}
              entries={conversations.active?.entries ?? []}
              onEntriesChange={setConversationEntries}
              conversationTitle={conversations.active?.title ?? 'Assistant'}
              onClose={panel.toggleAgent}
              onNewConversation={startNewChat}
              onClearConversation={clearConversation}
              onOpenSettings={settings.openSettings}
              pendingPrompt={pendingPrompt}
              onPendingPromptConsumed={() => setPendingPrompt('')}
            />
          ) : null
        }
        agentWidth={layout.agentWidth}
        onResizeAgent={layout.resizeAgent}
        statusbar={
          <Statusbar
            branch={branch}
            changeCount={changeCount}
            activeTab={activeTab}
            preview={preview.status}
            analysis={analysis.analysis}
            dockOpen={panel.dockOpen}
            dockTab={panel.dockTab}
            saveState={editor.saveState}
            notificationCount={0}
            onToggleDock={toggleDock}
            onOpenNotifications={() => toast.notify({
              title: 'Aucune notification',
              description: 'Les événements de l’agent et de l’aperçu apparaîtront ici.',
            })}
          />
        }
        overlays={
          <>
            <CommandPalette
              open={paletteOpen}
              onClose={() => setPaletteOpen(false)}
              onOpenFolder={openFolder}
              onToggleTerminal={panel.toggleTerminal}
              onToggleSidebar={layout.toggleSidebar}
              onOpenSettings={settings.openSettings}
              onOpenAgent={panel.openAgent}
              onNewFile={() => {
                editor.newUntitledFile()
                panel.hideHome()
              }}
              onNewChat={startNewChat}
              onSave={editor.saveFile}
              onOpenPreview={() => panel.selectDockTab('preview')}
              onOpenAnalysis={() => panel.selectDockTab('analysis')}
              onStartPreview={() => {
                panel.selectDockTab('preview')
                void preview.start('', settings.settings.previewAutoInstall)
              }}
              onOpenHome={panel.showHome}
              onCycleTheme={cycleTheme}
              onOpenTodo={() => selectView('todo')}
              onOpenHistory={() => selectView('history')}
              onOpenLicense={() => openSettingsTo('license')}
              tasks={tasksApi.tasks}
            />

            <SettingsPanel
              open={settings.settingsOpen}
              onClose={settings.closeSettings}
              settings={settings.settings}
              onUpdate={settings.update}
              onResetSettings={settings.resetSettings}
              onResetLayout={layout.resetLayout}
              account={{
                sessionToken: auth.sessionToken,
                user: auth.user ? { id: auth.user.id, name: auth.user.name, email: auth.user.email, createdAt: auth.user.createdAt } : null,
                online,
                planName: auth.user ? planBadge : 'FREE',
                licenseActive: auth.licenseActive,
                licenseType: auth.licenseType,
                licenseExpiresAt: auth.licenseExpiresAt,
                licenseSource: auth.licenseSource,
                activate: auth.activateLicense,
                activateGumroad: auth.activateGumroadLicense,
                deactivate: () => auth.deactivateLicense(),
                updateProfile: auth.updateProfile,
                changePassword: auth.changePassword,
                logout: () => auth.logout(),
              }}
            />

            {!updateDismissed && (
              <UpdateModal updates={updates} onClose={() => setUpdateDismissed(true)} />
            )}
          </>
        }
      />

      <SplashScreen visible={splashVisible} />
    </>
  )
}
