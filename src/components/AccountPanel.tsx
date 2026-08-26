import { useCallback, useState } from 'react'
import {
  BadgeCheck, KeyRound, Loader2, LogOut, Mail, PencilLine, ShieldCheck, User as UserIcon,
} from 'lucide-react'
import { Sidebar } from '../layout/Sidebar'
import { Modal } from './ui'
import { cx } from './ui/cx'

interface Props {
  sessionToken: string | null
  user: { id: number; name: string; email: string; createdAt: number } | null
  licenseActive: boolean
  licenseType: string | null
  licenseExpiresAt: number | null
  planName: string
  onUpdateProfile: (changes: { name?: string; email?: string }) => Promise<{ success: boolean; error?: string }>
  onChangePassword: (current: string, next: string) => Promise<{ success: boolean; error?: string }>
  onLogout: () => Promise<void>
}

type Mode = 'view' | 'edit-name' | 'edit-email' | 'edit-password' | 'confirm-logout'

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('') || '?'
}

/**
 * MON COMPTE — informations réelles du compte SQLite :
 * lecture, édition autorisée (nom/e-mail), changement de mot de passe réel
 * (bcrypt côté main, jamais affiché ni journalisé), déconnexion confirmée.
 */
export function AccountPanel({
  sessionToken, user, licenseActive, licenseType, licenseExpiresAt, planName,
  onUpdateProfile, onChangePassword, onLogout,
}: Props) {
  const [mode, setMode] = useState<Mode>('view')
  const [draftName, setDraftName] = useState('')
  const [draftEmail, setDraftEmail] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const closeForm = useCallback((): void => {
    setMode('view'); setOldPassword(''); setNewPassword(''); setConfirmPassword('')
    setFeedback(null)
  }, [])

  const saveName = useCallback(async (): Promise<void> => {
    setBusy(true)
    const result = await onUpdateProfile({ name: draftName })
    setBusy(false)
    if (result.success) { setFeedback({ tone: 'ok', text: 'Nom mis à jour.' }); setMode('view') }
    else setFeedback({ tone: 'error', text: result.error ?? 'Échec' })
  }, [draftName, onUpdateProfile])

  const saveEmail = useCallback(async (): Promise<void> => {
    setBusy(true)
    const result = await onUpdateProfile({ email: draftEmail })
    setBusy(false)
    if (result.success) { setFeedback({ tone: 'ok', text: 'Demande enregistrée : confirmez la nouvelle adresse via l’e-mail reçu.' }); setMode('view') }
    else setFeedback({ tone: 'error', text: result.error ?? 'Échec' })
  }, [draftEmail, onUpdateProfile])

  const savePassword = useCallback(async (): Promise<void> => {
    if (newPassword !== confirmPassword) {
      setFeedback({ tone: 'error', text: 'La confirmation ne correspond pas.' })
      return
    }
    setBusy(true)
    const result = await onChangePassword(oldPassword, newPassword)
    setBusy(false)
    if (result.success) { setFeedback({ tone: 'ok', text: 'Mot de passe modifié. Autres sessions déconnectées.' }); closeForm() }
    else setFeedback({ tone: 'error', text: result.error ?? 'Échec' })
  }, [oldPassword, newPassword, confirmPassword, onChangePassword, closeForm])

  return (
    <Sidebar title="MON COMPTE">
      {!user || !sessionToken ? (
        <p className="sub__muted">Non connecté.</p>
      ) : (
        <div className="account">
          <div className="account__identity">
            <span className="account__avatar" aria-hidden>{initialsOf(user.name)}</span>
            <div className="account__who">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
          </div>

          <dl className="account__grid">
            <div><dt className="sub__dt">Type de compte</dt><dd><UserIcon size={11} aria-hidden /> Standard</dd></div>
            <div><dt className="sub__dt">Plan</dt><dd>{planName}</dd></div>
            <div>
              <dt className="sub__dt">Statut</dt>
              <dd>{licenseActive ? 'Actif' : 'Inactif'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Licence</dt>
              <dd>{licenseActive
                ? (licenseType === 'lifetime' || licenseExpiresAt === null ? 'Lifetime' : 'Subscription')
                : 'Aucune licence premium'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Expiration</dt>
              <dd>{!licenseActive ? '—'
                : licenseExpiresAt === null
                  ? 'Aucune (lifetime)'
                  : new Date(licenseExpiresAt).toLocaleDateString('fr-FR', { dateStyle: 'long' })}</dd>
            </div>
            <div>
              <dt className="sub__dt">Temps restant</dt>
              <dd>{licenseActive && licenseExpiresAt !== null
                ? `${Math.max(0, Math.ceil((licenseExpiresAt - Date.now()) / 86_400_000))} j`
                : licenseActive ? 'Illimité' : '—'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Créé le</dt>
              <dd>{new Date(user.createdAt).toLocaleDateString('fr-FR', { dateStyle: 'medium' })}</dd>
            </div>
          </dl>

          <div className="account__actions">
            <button type="button" className="pkg__secondary" onClick={() => { setDraftName(user.name); setMode('edit-name') }}>
              <PencilLine size={12} /> Modifier le nom
            </button>
            <button type="button" className="pkg__secondary" onClick={() => { setDraftEmail(user.email); setMode('edit-email') }}>
              <Mail size={12} /> Modifier l’e-mail
            </button>
            <button type="button" className="pkg__secondary" onClick={() => setMode('edit-password')}>
              <KeyRound size={12} /> Modifier le mot de passe
            </button>
          </div>

          <p className="account__hint">
            <BadgeCheck size={12} aria-hidden /> Mot de passe&nbsp;:
            <span className="account__dots">••••••••••</span>
            (stocké uniquement en hash bcrypt — jamais affiché ni exporté)
          </p>

          <button type="button" className="account__logout" onClick={() => setMode('confirm-logout')}>
            <LogOut size={13} /> Se déconnecter
          </button>

          {feedback && (
            <div role="status" className={cx('pkg__error')} style={feedback.tone === 'ok' ? { borderColor: 'var(--c-success)', color: 'var(--c-success)', background: 'color-mix(in srgb, var(--c-success) 10%, transparent)' } : undefined}>
              {feedback.text}
            </div>
          )}
        </div>
      )}

      {/* Nom */}
      <Modal open={mode === 'edit-name'} onClose={closeForm} title="Modifier le nom" size="sm">
        <label className="auth-field"><span className="auth-field__label">Nouveau nom</span>
          <input value={draftName} onChange={e => setDraftName(e.target.value)} autoFocus />
        </label>
        <div className="account__form-actions">
          <button type="button" className="pkg__secondary" onClick={closeForm}>Annuler</button>
          <button type="button" className="sidebar__cta" disabled={busy || draftName.trim().length === 0} onClick={() => void saveName()}>
            {busy ? <Loader2 size={13} className="spin" aria-hidden /> : <PencilLine size={13} />} Enregistrer
          </button>
        </div>
      </Modal>

      {/* E-mail : confirmation explicite */}
      <Modal open={mode === 'edit-email'} onClose={closeForm} title="Modifier l’adresse e-mail" size="sm">
        <p className="sub__note">Un e-mail de confirmation sera envoyé à la nouvelle adresse : elle devient active après confirmation et servira à vous reconnecter.</p>
        <label className="auth-field"><span className="auth-field__label">Ancienne adresse</span>
          <input value={user?.email ?? ''} disabled readOnly />
        </label>
        <label className="auth-field"><span className="auth-field__label">Nouvelle adresse</span>
          <input value={draftEmail} onChange={e => setDraftEmail(e.target.value)} autoFocus />
        </label>
        <div className="account__form-actions">
          <button type="button" className="pkg__secondary" onClick={closeForm}>Annuler</button>
          <button type="button" className="sidebar__cta" disabled={busy || !draftEmail.includes('@') || draftEmail === user?.email} onClick={() => void saveEmail()}>
            {busy ? <Loader2 size={13} className="spin" aria-hidden /> : <ShieldCheck size={13} />} Confirmer
          </button>
        </div>
      </Modal>

      {/* Mot de passe */}
      <Modal open={mode === 'edit-password'} onClose={closeForm} title="Modifier le mot de passe" size="sm">
        <label className="auth-field"><span className="auth-field__label">Ancien mot de passe</span>
          <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoFocus />
        </label>
        <label className="auth-field"><span className="auth-field__label">Nouveau mot de passe (8+)</span>
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
        </label>
        <label className="auth-field"><span className="auth-field__label">Confirmation</span>
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
        </label>
        <div className="account__form-actions">
          <button type="button" className="pkg__secondary" onClick={closeForm}>Annuler</button>
          <button type="button" className="sidebar__cta" disabled={busy || !oldPassword || newPassword.length < 8} onClick={() => void savePassword()}>
            {busy ? <Loader2 size={13} className="spin" aria-hidden /> : <ShieldCheck size={13} />} Changer
          </button>
        </div>
      </Modal>

      {/* Déconnexion : confirmation */}
      <Modal open={mode === 'confirm-logout'} onClose={() => setMode('view')} title="Se déconnecter" size="sm">
        <p className="sub__note">Voulez-vous vous déconnecter ? Les requêtes IA en cours seront annulées.</p>
        <div className="account__form-actions">
          <button type="button" className="pkg__secondary" onClick={() => setMode('view')}>Annuler</button>
          <button type="button" className="account__logout account__logout--inline" onClick={() => { setMode('view'); void onLogout() }}>
            <LogOut size={13} /> Confirmer la déconnexion
          </button>
        </div>
      </Modal>
    </Sidebar>
  )
}
