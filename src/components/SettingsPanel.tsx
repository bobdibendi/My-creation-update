import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot, Check, Cpu, Database, Download, Eye, EyeOff, FolderTree,
  Gauge, Globe, Info, KeyRound, Keyboard, Loader2, Monitor, Palette,
  RotateCcw, Save, Trash2, Upload, UserRound, XCircle, type LucideIcon,
} from 'lucide-react'
import type { AIProviderInfo, SystemVersions } from '../shared/types'
import type { AppSettings } from '../hooks/useSettings'
import { THEMES, useTheme, FONT_LABELS, DENSITY_LABELS } from '../theme'
import type { Density, FontChoice } from '../theme'
import { LOCALES, useI18n } from '../i18n'
import {
  Badge, Button, Input, Modal, ScrollArea, Section, Segmented, Slider, StatusDot,
  Switch, Tooltip,
} from './ui'
import { LicenseSection } from './LicenseSection'
import { SHORTCUTS } from '../shared/shortcuts'
import { WHATS_NEW } from '../shared/whatsNew'
import { useUpdates } from '../hooks/useUpdates'
import { tabPanel, staggerContainer, riseIn } from '../animations'
import { cx } from './ui/cx'

export interface AccountInfo {
  sessionToken: string | null
  user: { id: number; name: string; email: string; createdAt: number } | null
  online: boolean
  planName: string
  licenseActive: boolean
  licenseType: string | null
  licenseExpiresAt: number | null
  licenseSource: 'my-creation' | 'gumroad' | null
  activate(key: string): Promise<{ success: boolean; error?: string }>
  activateGumroad(key: string): Promise<{ success: boolean; error?: string }>
  deactivate(): Promise<{ success: boolean; removed?: number }>
  updateProfile(changes: { name?: string; email?: string }): Promise<{ success: boolean; error?: string }>
  changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }>
  logout(): Promise<void>
}

interface Props {
  open: boolean
  onClose: () => void
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  onResetSettings: () => void
  onResetLayout: () => void
  account: AccountInfo
}

type SectionId =
  | 'general' | 'apparence' | 'themes' | 'police' | 'account' | 'license'
  | 'raccourcis' | 'providers' | 'modeles' | 'agent' | 'workspace' | 'preview'
  | 'data' | 'about'

const FONT_OPTIONS: FontChoice[] = ['system', 'grotesk', 'serif', 'mono']
const DENSITY_OPTIONS: Density[] = ['compact', 'normal', 'comfortable']

/**
 * Paramètres structurés : Général / Apparence / Compte & Licence /
 * Assistant IA / Données / À propos.
 *
 * Les clés API ne transitent jamais en clair : `storeKey` les confie au main
 * process (safeStorage) et seul un format masqué revient au renderer.
 */
export function SettingsPanel({
  open, onClose, settings, onUpdate, onResetSettings, onResetLayout, account,
}: Props) {
  const { t, locale, setLocale } = useI18n()
  const appearance = useTheme()
  const [section, setSection] = useState<SectionId>('general')
  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [masked, setMasked] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'success' | 'error'>('success')
  const [versions, setVersions] = useState<SystemVersions | null>(null)
  const [dataMessage, setDataMessage] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [accountMessage, setAccountMessage] = useState<string | null>(null)
  /** Modèle actif de l'assistant, pour l'affichage consommation. */
  const [activeModelLabel, setActiveModelLabel] = useState<string | null>(null)
  /** Mises à jour (GitHub Releases) : état réel partagé avec la modale App. */
  const updates = useUpdates({ autoCheck: false })

  useEffect(() => {
    const handler = (event: Event): void => {
      const label = (event as CustomEvent<{ label?: string }>).detail?.label
      if (typeof label === 'string' && label.length > 0) setActiveModelLabel(label)
    }
    document.addEventListener('assistant-model-changed', handler)
    return () => document.removeEventListener('assistant-model-changed', handler)
  }, [])

  // Saut direct vers une section (palette de commandes, menu profil).
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail as SectionId
      if (detail) setSection(detail)
    }
    document.addEventListener('open-settings-section', handler)
    return () => document.removeEventListener('open-settings-section', handler)
  }, [])

  useEffect(() => {
    if (!open) return
    void window.electronAPI?.system.getVersions().then(setVersions).catch(() => setVersions(null))
  }, [open])

  const loadProviders = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge) return
    const list = await bridge.api.listProviders()
    const manageable = list.filter(provider => provider.tier === 'premium')
    setProviders(manageable)
    setProviderId(previous => previous || manageable[0]?.id || '')
  }, [])

  useEffect(() => {
    if (!open) return
    void loadProviders()
  }, [open, loadProviders])

  useEffect(() => {
    if (!account.user) return
    setProfileName(account.user.name)
  }, [account.user])

  const selected = useMemo(
    () => providers.find(provider => provider.id === providerId) ?? null,
    [providers, providerId],
  )

  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge || !selected || !open) return
    setKeyInput('')
    setMessage('')
    void bridge.api.checkKey(selected.id).then(status => {
      setMasked(status.configured ? status.maskedKey ?? null : null)
      if (!status.success && status.error) {
        setMessage(status.error)
        setMessageTone('error')
      }
    })
  }, [selected, open])

  const saveKey = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !selected || keyInput.trim().length === 0) return
    const result = await bridge.api.storeKey(selected.id, keyInput.trim())
    if (result.success && result.configured) {
      setMasked(result.maskedKey ?? null)
      setMessage('Clé API enregistrée')
      setMessageTone('success')
      setKeyInput('')
      await loadProviders()
      document.dispatchEvent(new CustomEvent('api-keys-changed'))
      return
    }
    setMessage(result.error ?? 'La clé n’a pas pu être enregistrée')
    setMessageTone('error')
  }, [selected, keyInput, loadProviders])

  const removeKey = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !selected) return
    const result = await bridge.api.deleteKey(selected.id)
    if (!result.success || result.configured) {
      setMessage(result.error ?? 'La clé n’a pas pu être retirée')
      setMessageTone('error')
      return
    }
    setMasked(null)
    setMessage('Clé API retirée')
    setMessageTone('success')
    await loadProviders()
    document.dispatchEvent(new CustomEvent('api-keys-changed'))
  }, [selected, loadProviders])

  const exportData = useCallback(async (): Promise<void> => {
    const bridge = window.electronAPI
    if (!bridge) return
    try {
      const tasksPayload = account.sessionToken ? await bridge.tasks.list(account.sessionToken) : []
      const conversationsRaw = localStorage.getItem('cursor-clone.conversations')
      const payload = JSON.stringify({
        kind: 'my-creation-export',
        exportedAt: new Date().toISOString(),
        tasks: tasksPayload,
        conversations: conversationsRaw ? JSON.parse(conversationsRaw) : [],
        settings,
      }, null, 2)
      const result = await bridge.system.exportData(payload)
      setDataMessage(result.saved ? t('settings.exportDone') : null)
    } catch {
      setDataMessage(t('settings.importFailed'))
    }
  }, [account.sessionToken, settings, t])

  const importData = useCallback(async (): Promise<void> => {
    const bridge = window.electronAPI
    if (!bridge) return
    try {
      const result = await bridge.system.importData()
      if (!result.loaded || !result.payload) return
      const parsed = JSON.parse(result.payload) as {
        kind?: string
        tasks?: unknown[]
        conversations?: unknown
        settings?: Partial<AppSettings>
      }
      let imported = 0
      for (const task of parsed.tasks ?? []) {
        if (task && typeof task === 'object' && typeof (task as { title?: unknown }).title === 'string') {
          const created = await bridge.tasks.create(account.sessionToken, task as never)
          if (created) imported += 1
        }
      }
      if (parsed.settings && typeof parsed.settings === 'object') {
        for (const [key, value] of Object.entries(parsed.settings)) {
          if (key in settings) onUpdate(key as keyof AppSettings, value as never)
        }
      }
      setDataMessage(t('settings.importDone', { count: imported }))
    } catch {
      setDataMessage(t('settings.importFailed'))
    }
  }, [account.sessionToken, onUpdate, settings, t])

  const saveProfile = useCallback(async (): Promise<void> => {
    if (!account.user) return
    const result = await account.updateProfile({ name: profileName.trim() })
    setAccountMessage(result.success ? t('common.done') : result.error ?? t('errors.generic'))
  }, [account, profileName, t])

  const changePassword = useCallback(async (): Promise<void> => {
    if (newPassword.length < 8) {
      setAccountMessage(t('errors.generic'))
      return
    }
    const result = await account.changePassword(currentPassword, newPassword)
    if (result.success) {
      setCurrentPassword('')
      setNewPassword('')
    }
    setAccountMessage(result.success ? t('common.done') : result.error ?? t('errors.generic'))
  }, [account, currentPassword, newPassword, t])

  const shortcutGroups = useMemo(() => {
    const groups = new Map<string, typeof SHORTCUTS>()
    for (const shortcut of SHORTCUTS) {
      const list = groups.get(shortcut.group) ?? []
      list.push(shortcut)
      groups.set(shortcut.group, list)
    }
    return [...groups.entries()]
  }, [])

  const allModels = useMemo(
    () => providers.flatMap(provider => provider.models.map(model => ({ ...model, provider }))),
    [providers],
  )

  const NAV: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
    { id: 'general', label: t('settings.navGeneral'), icon: Globe },
    { id: 'apparence', label: t('settings.navAppearance'), icon: Palette },
    { id: 'themes', label: t('settings.navThemes'), icon: Palette },
    { id: 'police', label: t('settings.navFont'), icon: Palette },
    ...(account.user ? [{ id: 'account' as SectionId, label: t('settings.navAccount'), icon: UserRound }] : []),
    { id: 'license', label: t('settings.navLicense'), icon: KeyRound },
    { id: 'raccourcis', label: t('settings.navShortcuts'), icon: Keyboard },
    { id: 'providers', label: t('settings.navProviders'), icon: KeyRound },
    { id: 'modeles', label: t('settings.navModels'), icon: Cpu },
    { id: 'agent', label: t('settings.navAi'), icon: Bot },
    { id: 'workspace', label: t('settings.navWorkspace'), icon: FolderTree },
    { id: 'preview', label: t('settings.navPreview'), icon: Monitor },
    { id: 'data', label: t('settings.navData'), icon: Database },
    { id: 'about', label: t('settings.navAbout'), icon: Info },
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      icon={<Gauge size={16} />}
      className="settings-modal"
      footer={
        <>
          <Button variant="ghost" icon={<RotateCcw size={13} />} onClick={onResetSettings}>
            {t('settings.resetPreferences')}
          </Button>
          <Button variant="ghost" icon={<Gauge size={13} />} onClick={onResetLayout}>
            {t('settings.resetLayout')}
          </Button>
          <span className="settings__foot-fill" />
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      <div className="settings">
        <nav className="settings__nav" aria-label="Sections des paramètres">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={cx('settings__nav-item', section === id && 'is-active')}
              onClick={() => setSection(id)}
              aria-current={section === id}
            >
              <Icon size={14} />
              {label}
              {section === id && (
                <motion.span
                  layoutId="settings-nav-marker"
                  className="settings__nav-marker"
                  transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                />
              )}
            </button>
          ))}
        </nav>

        <ScrollArea className="settings__content">
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              variants={tabPanel(1)}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="settings__pane"
            >
              {section === 'general' && (
                <>
                  <Section title={t('settings.languageTitle')} description={t('settings.languageDesc')}>
                    <Segmented
                      ariaLabel={t('settings.languageTitle')}
                      value={locale}
                      onChange={value => setLocale(value)}
                      options={LOCALES.map(entry => ({ value: entry.id, label: entry.label }))}
                    />
                  </Section>

                  <Section title={t('settings.startupTitle')}>
                    <Switch
                      label={t('settings.showSplash')}
                      description={t('settings.showSplashDesc')}
                      checked={settings.showSplash}
                      onChange={value => onUpdate('showSplash', value)}
                    />
                    <Switch
                      label={t('settings.checkUpdatesOnLaunch')}
                      description={t('settings.checkUpdatesOnLaunchDesc')}
                      checked={settings.checkUpdates}
                      onChange={value => onUpdate('checkUpdates', value)}
                    />
                  </Section>

                  <Section title={t('settings.autosave')} description={t('settings.autosaveDesc')}>
                    <Switch
                      label={t('settings.autosave')}
                      checked={settings.autosave}
                      onChange={value => onUpdate('autosave', value)}
                    />
                  </Section>

                  <Section title={t('settings.notificationsTitle')} description={t('settings.notificationsDesc')}>
                    <Switch
                      label={t('settings.notifyAiChanges')}
                      checked={settings.notifyAiChanges}
                      onChange={value => onUpdate('notifyAiChanges', value)}
                    />
                  </Section>
                </>
              )}

              {section === 'apparence' && (
                <>
                  <Section title={t('settings.appearanceDensity')}>
                    <Segmented
                      ariaLabel={t('settings.appearanceDensity')}
                      value={appearance.density}
                      onChange={appearance.setDensity}
                      options={DENSITY_OPTIONS.map(value => ({ value, label: DENSITY_LABELS[value] }))}
                    />
                  </Section>

                  <Section title={t('settings.effectsTitle')}>
                    <Switch
                      label={t('settings.animations')}
                      description={t('settings.animationsDesc')}
                      checked={appearance.animations}
                      onChange={appearance.setAnimations}
                    />
                    <Switch
                      label={t('settings.blur')}
                      description={t('settings.blurDesc')}
                      checked={appearance.blur}
                      onChange={appearance.setBlur}
                    />
                    <Switch
                      label={t('settings.glow')}
                      description={t('settings.glowDesc')}
                      checked={appearance.glow}
                      onChange={appearance.setGlow}
                    />
                  </Section>

                  <Section title={t('settings.roundness')}>
                    <Slider
                      label={t('settings.roundness')}
                      valueLabel={`${Math.round(appearance.roundness * 100)}%`}
                      min={0.5}
                      max={1.5}
                      step={0.05}
                      value={appearance.roundness}
                      onChange={appearance.setRoundness}
                    />
                  </Section>
                </>
              )}

              {section === 'themes' && (
                <Section title={t('settings.navThemes')} description={THEMES.map(theme => theme.label).join(' · ')}>
                  <motion.div
                    className="theme-grid"
                    variants={staggerContainer(0.04)}
                    initial="hidden"
                    animate="visible"
                  >
                    {THEMES.map(theme => (
                      <motion.button
                        key={theme.id}
                        type="button"
                        variants={riseIn}
                        className={cx('theme-card', appearance.themeId === theme.id && 'is-active')}
                        onClick={() => appearance.setThemeId(theme.id)}
                        whileHover={{ y: -3 }}
                        whileTap={{ scale: 0.99 }}
                      >
                        <span
                          className="theme-card__preview"
                          style={{ background: theme.colors.bg }}
                          aria-hidden
                        >
                          <span style={{ background: theme.colors.surface }} />
                          <span style={{ background: theme.colors.surface2 }} />
                          <span style={{ background: theme.colors.accent }} />
                        </span>
                        <span className="theme-card__body">
                          <strong>
                            {theme.label}
                            {appearance.themeId === theme.id && <Check size={12} />}
                          </strong>
                          <small>{theme.description}</small>
                        </span>
                        <Badge size="sm" tone={theme.mode === 'dark' ? 'neutral' : 'warning'}>
                          {theme.mode === 'dark' ? t('settings.themeDark') : t('settings.themeLight')}
                        </Badge>
                      </motion.button>
                    ))}
                  </motion.div>
                </Section>
              )}

              {section === 'police' && (
                <>
                  <Section title={t('settings.uiFont')}>
                    <Segmented
                      ariaLabel={t('settings.uiFont')}
                      value={appearance.font}
                      onChange={appearance.setFont}
                      options={FONT_OPTIONS.map(value => ({ value, label: FONT_LABELS[value] }))}
                    />
                    <p className="settings__sample">
                      Le vif renard brun saute par-dessus le chien paresseux — 0123456789
                    </p>
                  </Section>

                  <Section title={t('settings.monoFont')}>
                    <Segmented
                      ariaLabel={t('settings.monoFont')}
                      value={appearance.monoFont}
                      onChange={appearance.setMonoFont}
                      options={FONT_OPTIONS.map(value => ({ value, label: FONT_LABELS[value] }))}
                    />
                    <pre className="settings__sample is-mono">
{`const total = items.reduce((sum, item) => sum + item.price, 0)
if (total > 0) console.info(\`total: \${total.toFixed(2)} €\`)`}
                    </pre>
                  </Section>
                </>
              )}

              {section === 'account' && (
                account.user ? (
                  <>
                    <Section title={t('settings.profileSection')}>
                      <label className="settings__label" htmlFor="settings-profile-name">{t('settings.displayName')}</label>
                      <div className="settings__key">
                        <input
                          id="settings-profile-name"
                          className="account__license-input"
                          value={profileName}
                          onChange={event => setProfileName(event.target.value)}
                        />
                        <Button variant="primary" size="sm" icon={<Save size={13} />} onClick={() => void saveProfile()}>
                          {t('common.save')}
                        </Button>
                      </div>
                      <p className="settings__note">{account.user.email}</p>
                    </Section>

                    <Section title={t('settings.planSection')}>
                      <div className="settings__version">
                        <span>{t('license.currentPlan')}</span>
                        <Badge tone="accent">{account.planName}</Badge>
                      </div>
                      <p className="settings__note">{account.online ? '' : t('statusbar.offline')}</p>
                    </Section>

                    <Section title="Mot de passe">
                      <Input
                        type="password"
                        placeholder="Mot de passe actuel"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={event => setCurrentPassword(event.target.value)}
                      />
                      <Input
                        type="password"
                        placeholder="Nouveau mot de passe (8+ caractères)"
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={event => setNewPassword(event.target.value)}
                      />
                      <Button variant="primary" disabled={!currentPassword || newPassword.length < 8} onClick={() => void changePassword()}>
                        {t('common.confirm')}
                      </Button>
                      {accountMessage && <p className="settings__note">{accountMessage}</p>}
                    </Section>

                    <Section title={t('common.account')}>
                      <Button variant="danger" onClick={() => void account.logout()}>
                        {t('common.logout')}
                      </Button>
                    </Section>
                  </>
                ) : (
                  <Section title={t('settings.localMode')} description={t('settings.localModeDesc')}>
                    <Button
                      variant="primary"
                      onClick={() => document.dispatchEvent(new CustomEvent('open-settings-section', { detail: 'license' }))}
                    >
                      {t('profileMenu.signIn')}
                    </Button>
                  </Section>
                )
              )}

              {section === 'license' && (
                <LicenseSection
                  sessionToken={account.sessionToken}
                  online={account.online}
                  licenseActive={account.licenseActive}
                  licenseType={account.licenseType}
                  licenseExpiresAt={account.licenseExpiresAt}
                  licenseSource={account.licenseSource}
                  planName={account.planName}
                  activeModelLabel={activeModelLabel}
                  onActivate={account.activate}
                  onActivateGumroad={account.activateGumroad}
                  onDeactivate={account.deactivate}
                />
              )}

              {section === 'raccourcis' && (
                <>
                  {shortcutGroups.map(([group, items]) => (
                    <Section key={group} title={group}>
                      <div className="shortcut-list">
                        {items.map(shortcut => (
                          <div className="shortcut-list__row" key={shortcut.id}>
                            <span>{shortcut.label}</span>
                            <kbd>{shortcut.keys}</kbd>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ))}
                  <p className="settings__note">
                    Ctrl + K ouvre la recherche globale ; Ctrl + P reste disponible pour la palette.
                  </p>
                </>
              )}

              {section === 'providers' && (
                <>
                  <Section title={t('settings.navProviders')}>
                    <div className="provider-list">
                      {providers.map(provider => (
                        <button
                          key={provider.id}
                          type="button"
                          className={cx('provider-list__item', provider.id === providerId && 'is-active')}
                          onClick={() => setProviderId(provider.id)}
                        >
                          <StatusDot tone={provider.configured ? 'success' : 'warning'} />
                          <span className="provider-list__name">{provider.name}</span>
                          <span className="provider-list__meta">
                            {provider.models.length} modèle{provider.models.length > 1 ? 's' : ''}
                          </span>
                        </button>
                      ))}
                      {providers.length === 0 && (
                        <p className="settings__note">
                          Lance l’application Electron.
                        </p>
                      )}
                    </div>
                  </Section>

                  {selected && (
                    <Section
                      title={selected.name}
                      actions={
                        <Badge tone={selected.configured ? 'success' : 'warning'} size="sm">
                          {selected.configured ? 'configurée' : 'absente'}
                        </Badge>
                      }
                    >
                      <label className="settings__label">Clé actuelle</label>
                      {masked ? (
                        <div className="settings__key">
                          <code>{masked}</code>
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<Trash2 size={13} />}
                            onClick={() => void removeKey()}
                          >
                            Retirer
                          </Button>
                        </div>
                      ) : (
                        <div className="settings__key is-empty">Aucune clé configurée</div>
                      )}

                      <label className="settings__label" htmlFor="settings-key-input">
                        Ajouter ou remplacer
                      </label>
                      <Input
                        id="settings-key-input"
                        type={reveal ? 'text' : 'password'}
                        value={keyInput}
                        placeholder="Coller la clé API"
                        autoComplete="off"
                        onChange={event => setKeyInput(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter') void saveKey() }}
                        trailing={
                          <Tooltip content={reveal ? 'Masquer' : 'Afficher'} side="left">
                            <button
                              type="button"
                              className="settings__reveal"
                              onClick={() => setReveal(current => !current)}
                              aria-label={reveal ? 'Masquer la clé' : 'Afficher la clé'}
                            >
                              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </Tooltip>
                        }
                      />
                      <Button
                        variant="primary"
                        icon={<Save size={13} />}
                        onClick={() => void saveKey()}
                        disabled={keyInput.trim().length === 0}
                      >
                        Enregistrer
                      </Button>

                      <AnimatePresence>
                        {message && (
                          <motion.div
                            className={cx('settings__message', `is-${messageTone}`)}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                          >
                            {messageTone === 'success' ? <Check size={13} /> : <XCircle size={13} />}
                            {message}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </Section>
                  )}
                </>
              )}

              {section === 'modeles' && (
                <Section
                  title={t('settings.navModels')}
                  actions={<Badge size="sm">{allModels.length}</Badge>}
                >
                  <div className="model-list">
                    {allModels.map(model => (
                      <div className="model-list__row" key={`${model.provider.id}-${model.id}`}>
                        <StatusDot tone={model.provider.configured ? 'success' : 'warning'} />
                        <span className="model-list__label">{model.label}</span>
                        <span className="model-list__provider">{model.provider.name}</span>
                        <Badge tone={model.supportsTools ? 'accent' : 'neutral'} size="sm">
                          {model.supportsTools ? 'outils' : 'chat seul'}
                        </Badge>
                      </div>
                    ))}
                    {allModels.length === 0 && (
                      <p className="settings__note">Aucun modèle exposé par les fournisseurs.</p>
                    )}
                  </div>
                </Section>
              )}

              {section === 'agent' && (
                <>
                  <Section title={t('settings.defaultMode')}>
                    <Segmented
                      ariaLabel={t('settings.defaultMode')}
                      value={settings.defaultMode}
                      onChange={value => onUpdate('defaultMode', value)}
                      options={[
                        { value: 'agent', label: 'Agent' },
                        { value: 'chat', label: 'Chat' },
                      ]}
                    />
                  </Section>

                  <Section title="Contexte envoyé">
                    <Switch
                      label={t('settings.sendActiveFile')}
                      checked={settings.sendFileContents}
                      onChange={value => onUpdate('sendFileContents', value)}
                    />
                    <Switch
                      label={t('settings.autoOpenAgent')}
                      checked={settings.autoOpenAgent}
                      onChange={value => onUpdate('autoOpenAgent', value)}
                    />
                    <Switch
                      label={t('settings.analysisAutoRefresh')}
                      checked={settings.analysisAutoRefresh}
                      onChange={value => onUpdate('analysisAutoRefresh', value)}
                    />
                  </Section>
                </>
              )}

              {section === 'workspace' && (
                <Section title={t('settings.profileSection')}>
                  <Input
                    value={settings.userName}
                    placeholder="Votre prénom"
                    aria-label={t('settings.displayName')}
                    onChange={event => onUpdate('userName', event.target.value)}
                  />
                </Section>
              )}

              {section === 'preview' && (
                <Section title={t('settings.navPreview')}>
                  <Switch
                    label={t('settings.previewAutoInstall')}
                    checked={settings.previewAutoInstall}
                    onChange={value => onUpdate('previewAutoInstall', value)}
                  />
                  <Switch
                    label={t('settings.autoRevealPreview')}
                    checked={settings.autoRevealPreview}
                    onChange={value => onUpdate('autoRevealPreview', value)}
                  />
                </Section>
              )}

              {section === 'data' && (
                <Section title={t('settings.navData')} description={t('settings.dataDesc')}>
                  <div className="settings__key">
                    <Button variant="primary" icon={<Download size={13} />} onClick={() => void exportData()}>
                      {t('settings.dataExport')}
                    </Button>
                    <Button variant="secondary" icon={<Upload size={13} />} onClick={() => void importData()}>
                      {t('settings.dataImport')}
                    </Button>
                  </div>
                  {dataMessage && <p className="settings__note">{dataMessage}</p>}
                </Section>
              )}

              {section === 'about' && (
                <>
                  <Section title={t('settings.aboutVersion')}>
                    <div className="settings__version">
                      <span>My Creation</span>
                      <code>{versions ? `${versions.app} (Electron ${versions.electron})` : <Loader2 size={13} className="spin" aria-hidden />}</code>
                    </div>
                  </Section>

                  <Section title={t('settings.aboutUpdates')} description={t('settings.checkUpdatesOnLaunchDesc')}>
                    {!updates.supported ? (
                      <div className="settings__version">
                        <Check size={13} aria-hidden />
                        <span>{t('settings.upToDate')}</span>
                      </div>
                    ) : updates.phase === 'downloaded' ? (
                      <div className="settings__version">
                        <Check size={13} aria-hidden />
                        <span>{t('update.readyTitle')}{updates.version ? ` — ${updates.version}` : ''}</span>
                      </div>
                    ) : updates.phase === 'available' || updates.phase === 'downloading' ? (
                      <div className="settings__version">
                        <Loader2 size={13} className="spin" aria-hidden />
                        <span>{updates.phase === 'downloading'
                          ? t('update.percent', { percent: String(updates.percent ?? 0) })
                          : t('update.availableTitle')}</span>
                      </div>
                    ) : (
                      <div className="settings__key">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<RotateCcw size={13} />}
                          onClick={() => void updates.check()}
                        >
                          {t('update.checkNow')}
                        </Button>
                        <span className="settings__note">{t('settings.upToDate')}</span>
                      </div>
                    )}
                  </Section>

                  <Section title={t('settings.whatsNew')}>
                    {WHATS_NEW.map(entry => (
                      <div className="whats-new" key={entry.version}>
                        <h3>My Creation {entry.version}</h3>
                        {entry.sections.map(group => (
                          <div key={group.title}>
                            <strong>{group.title === 'new' ? 'Nouveau' : group.title === 'improved' ? 'Amélioré' : 'Corrigé'}</strong>
                            <ul>
                              {group.items.map(item => <li key={item}>{item}</li>)}
                            </ul>
                          </div>
                        ))}
                      </div>
                    ))}
                  </Section>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </ScrollArea>
      </div>
    </Modal>
  )
}
