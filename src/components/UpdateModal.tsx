import { Download, RefreshCw, Rocket, X } from 'lucide-react'
import { useI18n } from '../i18n'
import type { UseUpdatesState } from '../hooks/useUpdates'

interface Props {
  updates: UseUpdatesState
  onClose(): void
}

/**
 * Modale de mise à jour (GitHub Releases) :
 *   disponible     -> [Mettre à jour] [Plus tard]
 *   téléchargement -> « Téléchargement XX % »
 *   prête          -> [Redémarrer maintenant]
 */
export function UpdateModal({ updates, onClose }: Props) {
  const { t } = useI18n()
  if (!updates.supported || updates.phase === 'idle') return null

  return (
    <div className="update-modal" role="alertdialog" aria-label={t('update.title')}>
      <div className="update-modal__card">
        <button type="button" className="update-modal__close" aria-label={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>

        {updates.phase === 'available' && (
          <>
            <span className="update-modal__icon" aria-hidden><Download size={18} /></span>
            <h2>{t('update.availableTitle')}</h2>
            <p>
              {updates.version
                ? t('update.availableVersion', { version: updates.version })
                : t('update.availableBody')}
            </p>
            <div className="update-modal__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
                {t('update.later')}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => { void updates.download() }}
              >
                <RefreshCw size={13} aria-hidden /> {t('update.updateNow')}
              </button>
            </div>
          </>
        )}

        {updates.phase === 'downloading' && (
          <>
            <span className="update-modal__icon" aria-hidden><Download size={18} /></span>
            <h2>{t('update.downloadingTitle')}</h2>
            <div
              className="update-modal__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={updates.percent ?? 0}
            >
              <span style={{ width: `${Math.min(100, Math.max(4, updates.percent ?? 4))}%` }} />
            </div>
            <p className="update-modal__percent">
              {t('update.percent', { percent: String(updates.percent ?? 0) })}
            </p>
          </>
        )}

        {updates.phase === 'downloaded' && (
          <>
            <span className="update-modal__icon is-ready" aria-hidden><Rocket size={18} /></span>
            <h2>{t('update.readyTitle')}</h2>
            <p>
              {updates.version
                ? t('update.readyVersion', { version: updates.version })
                : t('update.readyBody')}
            </p>
            <div className="update-modal__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
                {t('update.later')}
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={updates.install}>
                <Rocket size={13} aria-hidden /> {t('update.restartNow')}
              </button>
            </div>
          </>
        )}

        {updates.error && <p className="update-modal__error">{updates.error}</p>}
      </div>
    </div>
  )
}
