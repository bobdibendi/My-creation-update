import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, CreditCard, KeyRound, LogIn, Minus, Settings, Square, UserRound, WifiOff, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { Tooltip } from '../components/ui'
import { cx } from '../components/ui/cx'

interface Props {
  workspaceName: string
  /** Branch label, or null outside a repository. */
  branch: string | null
  agentBusy: boolean
  planName: string
  canUpgrade: boolean
  userName: string | null
  userEmail: string | null
  online: boolean
  onOpenAccount(): void
  onOpenLicense(): void
  onOpenSettings(): void
  onUpgrade(): void
  /** Null = mode local sans compte (pas de déconnexion possible). */
  onLogout(): void
}

/**
 * Frameless window chrome + profil.
 *
 * `.titlebar` est un contrat de test (`test-renderer.cjs`) : ne pas renommer.
 * La zone de drag est déclarée en CSS ; chaque enfant interactif doit en
 * sortir (`-webkit-app-region: no-drag` via les classes dédiées).
 */
export function Titlebar({
  workspaceName, branch, agentBusy, planName, canUpgrade, userName, userEmail,
  online, onOpenAccount, onOpenLicense, onOpenSettings, onUpgrade, onLogout,
}: Props) {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge) return
    void bridge.window.isMaximized().then(setMaximized).catch(() => { /* not ready */ })
    return bridge.window.onMaximized(setMaximized)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <header className="titlebar">
      <div className="titlebar__left">
        <span className="titlebar__mark" aria-hidden>
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path d="M12 2.6 21.4 12 12 21.4 2.6 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3.1" fill="currentColor" />
          </svg>
        </span>
        <span className="titlebar__name">My Creation</span>
        {!online && (
          <Tooltip content={t('statusbar.offline')} side="bottom">
            <span className="titlebar__offline"><WifiOff size={11} aria-hidden /> {t('statusbar.offline')}</span>
          </Tooltip>
        )}
      </div>

      <div className="titlebar__center">
        <span className="titlebar__crumb">{workspaceName || '—'}</span>
        {branch && (
          <>
            <span className="titlebar__dot" aria-hidden>·</span>
            <span className="titlebar__branch">{branch}</span>
          </>
        )}
        {agentBusy && (
          <motion.span
            className="titlebar__live"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            ● {t('statusbar.ready')}
          </motion.span>
        )}
      </div>

      <div className="titlebar__right">
        <div className="profile-chip" ref={menuRef}>
          <button
            type="button"
            className={cx('profile-chip__btn', menuOpen && 'is-open')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(current => !current)}
          >
            <span className="profile-chip__avatar" aria-hidden>
              {userName ? userName.charAt(0).toUpperCase() : <UserRound size={12} />}
            </span>
            <span className="profile-chip__meta">
              <strong>{userName ?? t('profileMenu.signedOut')}</strong>
              <small>{planName}</small>
            </span>
          </button>

          <AnimatePresence>
            {menuOpen && (
              <motion.div
                className="profile-menu"
                role="menu"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.14 }}
              >
                <div className="profile-menu__head">
                  <strong>{userName ?? t('profileMenu.signedOut')}</strong>
                  <small>{userEmail ?? t('profileMenu.signedOutHint')}</small>
                  <span className={cx('profile-menu__plan', planName !== 'FREE' && 'is-pro')}>{planName}</span>
                </div>

                {userName ? (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenAccount() }}>
                    <UserRound size={13} aria-hidden /> {t('common.account')}
                  </button>
                ) : (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenAccount() }}>
                    <LogIn size={13} aria-hidden /> {t('profileMenu.signIn')}
                  </button>
                )}

                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenLicense() }}>
                  <KeyRound size={13} aria-hidden /> {t('license.title')}
                </button>

                {canUpgrade && (
                  <button type="button" role="menuitem" className="is-upgrade" onClick={() => { setMenuOpen(false); onUpgrade() }}>
                    <CreditCard size={13} aria-hidden /> {t('sidebar.upgradeToPro')}
                  </button>
                )}

                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenSettings() }}>
                  <Settings size={13} aria-hidden /> {t('common.settings')}
                </button>

                {userName && (
                  <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuOpen(false); onLogout() }}>
                    {t('common.logout')}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Tooltip content={t('common.settings')} side="bottom">
          <button
            type="button"
            className="titlebar__btn"
            aria-label={t('common.settings')}
            onClick={onOpenSettings}
          >
            <Settings size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Réduire" side="bottom">
          <button
            type="button"
            className="titlebar__btn"
            aria-label="Réduire"
            onClick={() => void window.electronAPI?.window.minimize()}
          >
            <Minus size={13} />
          </button>
        </Tooltip>
        <Tooltip content={maximized ? 'Restaurer' : 'Agrandir'} side="bottom">
          <button
            type="button"
            className="titlebar__btn"
            aria-label={maximized ? 'Restaurer' : 'Agrandir'}
            onClick={() => void window.electronAPI?.window.maximize()}
          >
            {maximized ? <Copy size={11} /> : <Square size={11} />}
          </button>
        </Tooltip>
        <Tooltip content="Fermer" side="bottom">
          <button
            type="button"
            className="titlebar__btn titlebar__btn--close"
            aria-label="Fermer"
            onClick={() => void window.electronAPI?.window.close()}
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
