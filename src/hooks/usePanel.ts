import { useCallback, useState } from 'react'
import type { DockTab, MainView, Panel } from '../shared/types'

interface DockState {
  open: boolean
  tab: DockTab
}

export function usePanel() {
  const [activePanel, setActivePanel] = useState<Panel>('explorer')
  const [agentOpen, setAgentOpen] = useState(false)
  const [dock, setDock] = useState<DockState>({ open: false, tab: 'terminal' })
  /** True while the home screen is pinned over the editor. */
  const [homePinned, setHomePinned] = useState(true)
  /** Page affichée dans la zone centrale : accueil, éditeur, todo ou historique. */
  const [view, setView] = useState<MainView>('home')

  const togglePanel = useCallback((panel: Panel) => {
    setActivePanel(current => (current === panel ? '' : panel))
  }, [])

  const selectPanel = useCallback((panel: Panel) => setActivePanel(panel), [])

  const toggleAgent = useCallback(() => setAgentOpen(current => !current), [])
  const openAgent = useCallback(() => setAgentOpen(true), [])
  const closeAgent = useCallback(() => setAgentOpen(false), [])

  const showHome = useCallback(() => {
    setHomePinned(true)
    setView('home')
  }, [])
  const hideHome = useCallback(() => {
    setHomePinned(false)
    setView('editor')
  }, [])

  const showView = useCallback((next: MainView) => {
    setView(next)
    if (next === 'editor') setHomePinned(false)
    else if (next === 'home') setHomePinned(true)
    else setHomePinned(false)
  }, [])

  /**
   * Opens the dock on the requested tab, or closes it when that tab is already
   * showing. Asking for "Aperçu" while the terminal is open switches tab rather
   * than closing the panel.
   */
  const toggleDock = useCallback((tab: DockTab) => {
    setDock(current => {
      if (!current.open) return { open: true, tab }
      if (current.tab !== tab) return { open: true, tab }
      return { open: false, tab: current.tab }
    })
  }, [])

  const selectDockTab = useCallback((tab: DockTab) => {
    setDock({ open: true, tab })
  }, [])

  const closeDock = useCallback(() => {
    setDock(current => ({ ...current, open: false }))
  }, [])

  const toggleTerminal = useCallback(() => toggleDock('terminal'), [toggleDock])

  return {
    activePanel,
    agentOpen,
    view,
    showView,
    homeVisible: homePinned,
    dockOpen: dock.open,
    dockTab: dock.tab,
    togglePanel,
    selectPanel,
    toggleAgent,
    openAgent,
    closeAgent,
    showHome,
    hideHome,
    toggleDock,
    selectDockTab,
    closeDock,
    toggleTerminal,
  }
}
