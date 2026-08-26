import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'cursor-clone.layout'

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 460
export const SIDEBAR_DEFAULT = 268

export const AGENT_MIN = 340
export const AGENT_MAX = 760
export const AGENT_DEFAULT = 440

export const DOCK_MIN = 140
export const DOCK_DEFAULT = 320

interface LayoutState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  agentWidth: number
  dockHeight: number
  /** Navigation principale réduite (icônes seules). */
  navCollapsed: boolean
}

const DEFAULTS: LayoutState = {
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
  agentWidth: AGENT_DEFAULT,
  dockHeight: DOCK_DEFAULT,
  navCollapsed: false,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readStored(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      sidebarWidth: clamp(Number(parsed.sidebarWidth ?? SIDEBAR_DEFAULT), SIDEBAR_MIN, SIDEBAR_MAX),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      agentWidth: clamp(Number(parsed.agentWidth ?? AGENT_DEFAULT), AGENT_MIN, AGENT_MAX),
      dockHeight: Math.max(DOCK_MIN, Number(parsed.dockHeight ?? DOCK_DEFAULT)),
      navCollapsed: Boolean(parsed.navCollapsed),
    }
  } catch {
    return DEFAULTS
  }
}

/**
 * Persisted panel geometry.
 *
 * Sizes are stored as deltas applied by the resizers, clamped here rather than
 * in the handles so the constraints live in one place.
 */
export function useLayout() {
  const [state, setState] = useState<LayoutState>(readStored)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Storage unavailable: geometry simply resets next launch.
    }
  }, [state])

  const resizeSidebar = useCallback((delta: number) => {
    setState(previous => ({
      ...previous,
      sidebarWidth: clamp(previous.sidebarWidth + delta, SIDEBAR_MIN, SIDEBAR_MAX),
    }))
  }, [])

  const resizeAgent = useCallback((delta: number) => {
    // The agent panel is docked right: dragging left must widen it.
    setState(previous => ({
      ...previous,
      agentWidth: clamp(previous.agentWidth - delta, AGENT_MIN, AGENT_MAX),
    }))
  }, [])

  const resizeDock = useCallback((delta: number) => {
    setState(previous => ({
      ...previous,
      dockHeight: clamp(previous.dockHeight - delta, DOCK_MIN, Math.round(window.innerHeight * 0.85)),
    }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setState(previous => ({ ...previous, sidebarCollapsed: !previous.sidebarCollapsed }))
  }, [])

  const toggleNavCollapsed = useCallback(() => {
    setState(previous => ({ ...previous, navCollapsed: !previous.navCollapsed }))
  }, [])

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setState(previous => ({ ...previous, sidebarCollapsed: collapsed }))
  }, [])

  const resetLayout = useCallback(() => setState(DEFAULTS), [])

  return {
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    agentWidth: state.agentWidth,
    dockHeight: state.dockHeight,
    navCollapsed: state.navCollapsed,
    resizeSidebar,
    resizeAgent,
    resizeDock,
    toggleSidebar,
    toggleNavCollapsed,
    setSidebarCollapsed,
    resetLayout,
  }
}
