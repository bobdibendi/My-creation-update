import { useCallback, useEffect, useState } from 'react'
import type { GenerateResult, KeyStatus, MembershipPlan, PrivateKeyStatus } from '../electron/preload'

/** Presets de durée : chaque valeur modifie RÉELLEMENT le claim exp du JWT. */
const DURATION_PRESETS: Array<{ label: string; seconds?: number }> = [
  { label: 'Lifetime', seconds: undefined },
  { label: '1 minute', seconds: 60 },
  { label: '1 heure', seconds: 3600 },
  { label: '1 jour', seconds: 86_400 },
  { label: '7 jours', seconds: 7 * 86_400 },
  { label: '30 jours', seconds: 30 * 86_400 },
  { label: '90 jours', seconds: 90 * 86_400 },
  { label: '365 jours', seconds: 365 * 86_400 },
]

const PLAN_LABELS: Record<MembershipPlan, string> = {
  free: 'FREE',
  pro: 'PRO',
  pro_ultimate: 'PRO ULTIMATE',
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return 'Lifetime'
  const preset = DURATION_PRESETS.find(entry => entry.seconds === seconds)
  return preset?.label ?? `${Math.round(seconds / 86400)} jours`
}

function formatDateTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return '—'
  return new Date(epochSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' })
}

export default function App(): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState<MembershipPlan>('free')
  const [presetIndex, setPresetIndex] = useState(0)
  const [version, setVersion] = useState('1.0.0')
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [privateKeyStatus, setPrivateKeyStatus] = useState<PrivateKeyStatus | null>(null)
  const [chooseError, setChooseError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  const preset = DURATION_PRESETS[presetIndex]
  const durationType: 'lifetime' | 'subscription' = preset.seconds ? 'subscription' : 'lifetime'

  useEffect(() => {
    const bridge = window.licenseApi
    if (!bridge) {
      setKeyStatus({ found: false, path: null })
      setPrivateKeyStatus({
        found: false, path: null, stored: false, storedPathMissing: false,
      })
      setChooseError(
        'Le pont Electron (licenseApi) est indisponible : lance l’application via son exécutable ou npm run dev.',
      )
      return
    }
    void bridge.getKeyStatus().then(setKeyStatus).catch((err: unknown) => {
      setChooseError(`Vérification de la clé impossible : ${err instanceof Error ? err.message : String(err)}`)
    })
    void bridge.getPrivateKeyStatus().then(setPrivateKeyStatus).catch(() => { /* état par défaut conservé */ })
  }, [])

  const refreshKeyStatus = useCallback((): void => {
    const bridge = window.licenseApi
    if (!bridge) return
    void bridge.getKeyStatus().then(setKeyStatus).catch(() => { /* dernier état conservé */ })
    void bridge.getPrivateKeyStatus().then(setPrivateKeyStatus).catch(() => { /* dernier état conservé */ })
  }, [])

  const choosePrivateKey = useCallback(async (): Promise<void> => {
    setChooseError(null)
    const bridge = window.licenseApi
    if (!bridge) {
      setChooseError('Pont Electron indisponible : relance l’application.')
      return
    }
    let res: Awaited<ReturnType<typeof bridge.choosePrivateKey>>
    try {
      res = await bridge.choosePrivateKey()
    } catch (err) {
      setChooseError(`Sélection impossible : ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!res.ok && res.error) {
      setChooseError(res.error)
      return
    }
    if (res.ok) {
      refreshKeyStatus()
    }
  }, [refreshKeyStatus])

  const generate = useCallback(async (): Promise<void> => {
    setSavedMessage(null)
    const params =
      durationType === 'lifetime'
        ? { email, plan, durationType, version: version || null }
        : { email, plan, durationType, durationSeconds: preset.seconds, version: version || null }
    try {
      const res = await window.licenseApi.generateLicense(params)
      setResult(res)
      if (res.ok) refreshKeyStatus()
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [email, plan, durationType, preset.seconds, version, refreshKeyStatus])

  const copyToken = useCallback(async (): Promise<void> => {
    if (!result?.token) return
    await navigator.clipboard.writeText(result.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [result])

  const saveToken = useCallback(async (): Promise<void> => {
    if (!result?.token || !result.info) return
    const safeEmail = result.info.email.replace(/[^a-z0-9._-]+/gi, '_')
    const name = `licence-${safeEmail}-${result.info.plan}-${result.info.durationType}.txt`
    try {
      const res = await window.licenseApi.saveLicense(name, result.token)
      if (!res.ok) {
        setSavedMessage(`Erreur : ${res.error ?? 'inconnue'}`)
        return
      }
      setSavedMessage(res.canceled ? null : `Sauvegardé : ${res.path}`)
    } catch (err) {
      setSavedMessage(`Erreur : ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [result])

  const fillTestMode = useCallback((): void => {
    setEmail('test@example.com')
    setPlan('pro')
    setPresetIndex(1) // 1 minute
    setVersion('')
  }, [])

  const info = result?.ok ? result.info : undefined

  return (
    <div className="app">
      <header className="header">
        <h1>My Creation License Generator</h1>
        <p>Outil admin local — génère des licences JWT RS256 signées avec la clé privée.</p>
        <div className="key-status">
          <span className={`dot ${keyStatus?.found ? 'ok' : keyStatus === null ? '' : 'ko'}`} />
          {keyStatus === null ? (
            <span>Vérification de la clé privée…</span>
          ) : keyStatus.found ? (
            <span>Clé privée trouvée&nbsp;: {keyStatus.path}</span>
          ) : privateKeyStatus?.storedPathMissing ? (
            <span>Clé privée introuvable — veuillez en sélectionner une nouvelle.</span>
          ) : (
            <span>Aucune clé privée configurée.</span>
          )}
        </div>
      </header>

      <section className="card">
        <span className="field-label">Clé privée</span>
        <div className="row" style={{ alignItems: 'center', gap: '12px' }}>
          <span style={{ flex: 1, fontSize: '0.9em', opacity: 0.85, wordBreak: 'break-all' }}>
            {privateKeyStatus === null
              ? 'Vérification…'
              : privateKeyStatus.found
                ? privateKeyStatus.path
                : 'Aucune clé sélectionnée'}
          </span>
          <button className="secondary" onClick={() => void choosePrivateKey()}>
            Choisir private.pem
          </button>
        </div>
        {chooseError && <div className="error" style={{ marginTop: '8px' }}>{chooseError}</div>}
      </section>

      {keyStatus && !keyStatus.found && (
        <div className="error">
          Générez d&apos;abord la paire de clés :
          {'\n'}openssl genrsa -out private.pem 2048
          {'\n'}openssl rsa -in private.pem -pubout -out public.pem
        </div>
      )}

      <section className="card">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            placeholder="client@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="field-label">Niveau d’adhésion</span>
          <div className="segmented" role="group" aria-label="Niveau d’adhésion">
            <button className={plan === 'free' ? 'active' : ''} onClick={() => setPlan('free')}>
              Free
            </button>
            <button className={plan === 'pro' ? 'active' : ''} onClick={() => setPlan('pro')}>
              Pro
            </button>
            <button className={plan === 'pro_ultimate' ? 'active' : ''} onClick={() => setPlan('pro_ultimate')}>
              Pro Ultimate
            </button>
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="duration-preset">Durée de licence</label>
          <select
            id="duration-preset"
            value={presetIndex}
            onChange={(e) => setPresetIndex(Number(e.target.value))}
          >
            {DURATION_PRESETS.map((entry, index) => (
              <option key={entry.label} value={index}>{entry.label}</option>
            ))}
          </select>
        </div>

        <div className="row">
          <div className="field grow">
            <label htmlFor="version">Version produit</label>
            <input
              id="version"
              type="text"
              value={version}
              placeholder="1.0.0"
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
          <button className="primary" disabled={!email.trim()} onClick={() => void generate()}>
            Générer la licence
          </button>
        </div>

        <div className="test-mode">
          Mode test :
          <button className="link" onClick={fillTestMode}>
            Remplir test@example.com / Pro / 1 minute
          </button>
        </div>
      </section>

      {result && !result.ok && result.error && <div className="error">{result.error}</div>}

      {result?.ok && result.token && (
        <section className="card">
          <span className="field-label">JWT généré</span>
          <textarea className="token-box" readOnly value={result.token} onFocus={(e) => e.currentTarget.select()} />
          <div className="actions">
            <button className="secondary" onClick={() => void copyToken()}>
              {copied ? 'Copié ✓' : 'Copier'}
            </button>
            <button className="secondary" onClick={() => void saveToken()}>
              Sauvegarder…
            </button>
            {savedMessage && <span className="success">{savedMessage}</span>}
          </div>
        </section>
      )}

      {info && (
        <section className="card">
          <span className="field-label">Licence générée</span>
          <dl className="info-grid">
            <dt>Email</dt>
            <dd>{info.email}</dd>
            <dt>Plan</dt>
            <dd><span className={`badge ${info.plan}`}>{PLAN_LABELS[info.plan]}</span></dd>
            <dt>Type</dt>
            <dd>{info.durationType === 'lifetime' ? 'LIFETIME' : 'SUBSCRIPTION'}</dd>
            <dt>Durée</dt>
            <dd>{durationLabel(info.durationSeconds)}</dd>
            <dt>Expiration</dt>
            <dd>{info.expiresAt !== null ? formatDateTime(info.expiresAt) : 'Aucune (lifetime)'}</dd>
            <dt>License ID</dt>
            <dd>{info.licenseId}</dd>
            <dt>Version</dt>
            <dd>{info.version ?? '—'}</dd>
          </dl>
        </section>
      )}
    </div>
  )
}
