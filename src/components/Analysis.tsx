import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Boxes, Camera, CheckCircle2, FileCode2, Gauge, Layers, Network, Package,
  RefreshCw, Ruler, ScrollText, Terminal as TerminalIcon, TestTube2, TriangleAlert, XCircle,
} from 'lucide-react'
import { ProjectGraph } from './ProjectGraph'
import { BarChart, Donut, StackedMeter } from './Charts'
import {
  Badge, EmptyState, IconButton, ScrollArea, Section, Segmented, SkeletonCard, Spinner, Tooltip,
} from './ui'
import { riseIn, staggerContainer } from '../animations'
import { cx } from './ui/cx'
import type { PreviewCapture, ProjectAnalysis, ProjectGraph as ProjectGraphData } from '../shared/types'

interface Props {
  workspace: string | null
  analysis: ProjectAnalysis | null
  graph: ProjectGraphData | null
  capture: PreviewCapture | null
  loading: boolean
  error: string
  capturing: boolean
  onRefresh: () => void
  onCapture: () => void
}

type AnalysisTab = 'apercu' | 'arbre' | 'dependances' | 'qualite'

function formatNumber(value: number): string {
  return value.toLocaleString('fr-FR')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} o`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} Ko`
  return `${(value / (1024 * 1024)).toFixed(1)} Mo`
}

function StatCard({
  icon, label, value, hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <motion.div className="stat" variants={riseIn}>
      <span className="stat__icon" aria-hidden>{icon}</span>
      <strong className="stat__value">{value}</strong>
      <span className="stat__label">{label}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </motion.div>
  )
}

/**
 * Project report: identity, statistics, dependencies, issues, capture, graph.
 *
 * Test coverage is inferred from the presence of test files and a test script
 * rather than parsed from a coverage report: no runner is configured in the
 * projects this app opens, and a fabricated percentage would be worse than an
 * honest signal.
 */
export function Analysis({
  workspace, analysis, graph, capture, loading, error, capturing, onRefresh, onCapture,
}: Props) {
  const [tab, setTab] = useState<AnalysisTab>('apercu')

  const errors = useMemo(
    () => (analysis?.issues ?? []).filter(issue => issue.severity === 'error'),
    [analysis],
  )
  const warnings = useMemo(
    () => (analysis?.issues ?? []).filter(issue => issue.severity === 'warning'),
    [analysis],
  )

  const languageData = useMemo(
    () => (analysis?.languages ?? []).slice(0, 8).map(entry => ({
      label: entry.language,
      value: entry.files,
    })),
    [analysis],
  )

  const lineData = useMemo(
    () => (analysis?.languages ?? []).slice(0, 8).map(entry => ({
      label: entry.language,
      value: entry.lines,
    })),
    [analysis],
  )

  const health = useMemo(() => {
    if (!analysis) return 0
    // One error costs 12 points, one warning 4, floored at zero.
    const penalty = errors.length * 12 + warnings.length * 4
    return Math.max(0, Math.min(100, 100 - penalty)) / 100
  }, [analysis, errors.length, warnings.length])

  const hasTestScript = useMemo(
    () => (analysis?.scripts ?? []).some(script => /test|vitest|jest/i.test(script.name)),
    [analysis],
  )

  const prodDeps = useMemo(
    () => (analysis?.dependencies ?? []).filter(entry => !entry.dev),
    [analysis],
  )
  const devDeps = useMemo(
    () => (analysis?.dependencies ?? []).filter(entry => entry.dev),
    [analysis],
  )

  if (!workspace) {
    return (
      <div className="analysis">
        <EmptyState
          icon={<Layers size={24} />}
          title="Aucun projet analysé"
          description="Ouvre un dossier pour voir son architecture et ses statistiques."
        />
      </div>
    )
  }

  return (
    <div className="analysis">
      <div className="analysis__toolbar">
        <Segmented
          size="sm"
          ariaLabel="Vue de l’analyse"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'apercu', label: 'Aperçu', icon: <Gauge size={12} /> },
            { value: 'arbre', label: 'Arbre', icon: <Network size={12} /> },
            { value: 'dependances', label: 'Dépendances', icon: <Package size={12} /> },
            { value: 'qualite', label: 'Qualité', icon: <TestTube2 size={12} /> },
          ]}
        />
        <span className="analysis__toolbar-fill" />
        {analysis && (
          <Badge tone={analysis.state === 'PASS' ? 'success' : 'danger'} size="sm" dot>
            {analysis.state}
          </Badge>
        )}
        <Tooltip content="Recalculer l’analyse" side="top">
          <IconButton
            label="Recalculer l’analyse"
            size="sm"
            icon={loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
            onClick={onRefresh}
            disabled={loading}
          />
        </Tooltip>
        <Tooltip content="Capturer l’aperçu" side="top">
          <IconButton
            label="Capturer l’aperçu"
            size="sm"
            icon={capturing ? <Spinner size={13} /> : <Camera size={13} />}
            onClick={onCapture}
            disabled={capturing}
          />
        </Tooltip>
      </div>

      {error.length > 0 && (
        <div className="analysis__error">
          <TriangleAlert size={12} />
          <span>{error}</span>
        </div>
      )}

      <ScrollArea className="analysis__body">
        {!analysis && loading && (
          <div className="analysis__loading">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </div>
        )}

        {!analysis && !loading && (
          <EmptyState
            icon={<Layers size={22} />}
            title="Analyse non calculée"
            description="Lance l’analyse pour obtenir les statistiques du projet."
            action={
              <button type="button" className="analysis__cta" onClick={onRefresh}>
                Analyser maintenant
              </button>
            }
          />
        )}

        {analysis && tab === 'apercu' && (
          <motion.div
            className="analysis__pane"
            variants={staggerContainer(0.04)}
            initial="hidden"
            animate="visible"
          >
            <motion.section className="analysis__identity" variants={riseIn}>
              <div className="analysis__identity-main">
                <span className="analysis__field">Projet</span>
                <strong className="analysis__project">{analysis.name}</strong>
                <span className="analysis__meta">
                  <Badge tone="accent" size="sm">{analysis.typeLabel}</Badge>
                  <Badge size="sm">{analysis.framework}</Badge>
                  {analysis.truncated && <Badge tone="warning" size="sm">analyse partielle</Badge>}
                </span>
              </div>
              <Donut
                value={health}
                label="santé"
                tone={health > 0.85 ? 'success' : health > 0.6 ? 'warning' : 'danger'}
                caption={`${errors.length} erreur(s) · ${warnings.length} avert.`}
              />
            </motion.section>

            <motion.div className="analysis__stats" variants={staggerContainer(0.03)}>
              <StatCard icon={<FileCode2 size={14} />} label="Fichiers" value={formatNumber(analysis.stats.files)} />
              <StatCard icon={<Boxes size={14} />} label="Composants" value={formatNumber(analysis.stats.components)} />
              <StatCard icon={<Ruler size={14} />} label="Lignes" value={formatNumber(analysis.stats.lines)} />
              <StatCard icon={<Layers size={14} />} label="Dossiers" value={formatNumber(analysis.stats.directories)} />
              <StatCard
                icon={<Package size={14} />}
                label="Dépendances"
                value={formatNumber(analysis.dependencies.length)}
                hint={formatBytes(analysis.stats.bytes)}
              />
            </motion.div>

            {languageData.length > 0 && (
              <Section title="Langages" description="Nombre de fichiers par langage.">
                <StackedMeter ariaLabel="Répartition des langages" segments={languageData} />
                <BarChart data={languageData} />
              </Section>
            )}

            {analysis.scripts.length > 0 && (
              <Section title="Scripts npm" actions={<Badge size="sm">{analysis.scripts.length}</Badge>}>
                <div className="analysis__scripts">
                  {analysis.scripts.map(entry => (
                    <div className="analysis__script" key={entry.name}>
                      <TerminalIcon size={11} />
                      <span className="analysis__script-name">{entry.name}</span>
                      <code>{entry.command}</code>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Capture de l’aperçu">
              {capture ? (
                <figure className="analysis__capture">
                  <img src={capture.dataUrl} alt={`Capture de l’aperçu ${capture.url}`} />
                  <figcaption>
                    {capture.relativePath} · {formatBytes(capture.bytes)}
                    {capture.width > 0 ? ` · ${capture.width}×${capture.height}` : ''}
                  </figcaption>
                </figure>
              ) : (
                <p className="analysis__note">
                  <Camera size={13} /> Aucune capture. Démarre l’aperçu puis utilise le bouton capture.
                </p>
              )}
            </Section>
          </motion.div>
        )}

        {analysis && tab === 'arbre' && (
          <motion.div className="analysis__pane" variants={riseIn} initial="hidden" animate="visible">
            {graph ? <ProjectGraph graph={graph} /> : (
              <EmptyState
                icon={<Network size={22} />}
                title="Arbre indisponible"
                description="Relance l’analyse pour reconstruire l’arborescence."
                compact
              />
            )}
          </motion.div>
        )}

        {analysis && tab === 'dependances' && (
          <motion.div
            className="analysis__pane"
            variants={staggerContainer(0.04)}
            initial="hidden"
            animate="visible"
          >
            <motion.div className="analysis__stats" variants={staggerContainer(0.03)}>
              <StatCard icon={<Package size={14} />} label="Production" value={formatNumber(prodDeps.length)} />
              <StatCard icon={<Package size={14} />} label="Développement" value={formatNumber(devDeps.length)} />
              <StatCard
                icon={<ScrollText size={14} />}
                label="Commandes de vérification"
                value={formatNumber(analysis.checkCommands.length)}
              />
            </motion.div>

            {prodDeps.length > 0 && (
              <Section title="Production" actions={<Badge size="sm">{prodDeps.length}</Badge>}>
                <div className="analysis__deps">
                  {prodDeps.map(entry => (
                    <span className="analysis__dep" key={`${entry.name}-prod`}>
                      {entry.name}
                      <em>{entry.version}</em>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {devDeps.length > 0 && (
              <Section title="Développement" actions={<Badge size="sm">{devDeps.length}</Badge>}>
                <div className="analysis__deps">
                  {devDeps.map(entry => (
                    <span className="analysis__dep is-dev" key={`${entry.name}-dev`}>
                      {entry.name}
                      <em>{entry.version}</em>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {analysis.dependencies.length === 0 && (
              <EmptyState
                icon={<Package size={22} />}
                title="Aucune dépendance"
                description="Ce projet n’a pas de manifeste npm exploitable."
                compact
              />
            )}
          </motion.div>
        )}

        {analysis && tab === 'qualite' && (
          <motion.div
            className="analysis__pane"
            variants={staggerContainer(0.04)}
            initial="hidden"
            animate="visible"
          >
            <Section
              title="Problèmes détectés"
              description={`${errors.length} erreur(s) · ${warnings.length} avertissement(s)`}
              actions={
                <Badge tone={analysis.state === 'PASS' ? 'success' : 'danger'} size="sm">
                  {analysis.state}
                </Badge>
              }
            >
              {analysis.issues.length === 0 ? (
                <p className="analysis__note is-ok">
                  <CheckCircle2 size={13} /> Aucun problème détecté.
                </p>
              ) : (
                <ul className="analysis__issues">
                  {analysis.issues.slice(0, 60).map((issue, index) => (
                    <li key={`${issue.file ?? 'global'}-${index}`} className={cx(`is-${issue.severity}`)}>
                      {issue.severity === 'error' ? <XCircle size={11} /> : <TriangleAlert size={11} />}
                      {issue.file && <span className="analysis__issue-file">{issue.file}</span>}
                      <span className="analysis__issue-msg">{issue.message}</span>
                      <span className="analysis__issue-src">{issue.source}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Couverture des tests">
              <div className="analysis__coverage">
                <Donut
                  value={hasTestScript ? 0.5 : 0}
                  label="tests"
                  tone={hasTestScript ? 'accent' : 'danger'}
                  caption={hasTestScript ? 'script de test présent' : 'aucun script de test'}
                />
                <p className="analysis__note">
                  Aucun rapport de couverture n’est produit par ce projet. L’indicateur reflète
                  seulement la présence d’un script de test dans le manifeste, pas un pourcentage
                  de lignes couvertes.
                </p>
              </div>
            </Section>

            <Section title="Performances" description="Volume de code par langage, indicateur de charge de maintenance.">
              <BarChart data={lineData} format={formatNumber} />
            </Section>

            {analysis.checkCommands.length > 0 && (
              <Section title="Commandes de vérification">
                <div className="analysis__scripts">
                  {analysis.checkCommands.map(command => (
                    <div className="analysis__script" key={command}>
                      <TerminalIcon size={11} />
                      <code>{command}</code>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </motion.div>
        )}
      </ScrollArea>
    </div>
  )
}
