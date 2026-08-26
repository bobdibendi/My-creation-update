import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowRight, Bug, CheckCircle2, CircleDashed, Clock, FileCode2, FolderOpen,
  Globe, Layers, Plug, Plus, ShieldAlert,
} from 'lucide-react'
import type { ProjectAnalysis, Task } from '../shared/types'
import { Badge, Skeleton } from './ui'
import { staggerContainer, riseIn, transitions } from '../animations'
import { cx } from './ui/cx'
import { useI18n } from '../i18n'

interface Props {
  userName: string
  workspaceName: string
  workspacePath: string | null
  analysis: ProjectAnalysis | null
  analysisLoading: boolean
  recentFiles: string[]
  recentProjects: Array<{ path: string; name: string; lastOpenedAt: number }>
  /** Résumé Todo réel — poussé par le store temps réel. */
  todoTasks: Task[]
  onPrompt: (prompt: string) => void
  onCreate(): void
  onOpenFolder(): void
  onOpenRecentProject(path: string): void
  onOpenTerminal(): void
  onOpenAnalysis(): void
  onOpenFile(path: string): void
  onOpenTodo(): void
}

const TEMPLATE_PROMPTS = {
  site: 'Crée un site web moderne et responsive dans ce dossier, puis lance l’aperçu.',
  api: 'Crée une API REST typée dans ce projet avec validation des entrées et gestion des erreurs.',
  analyse: 'Analyse ce projet : architecture, dépendances, dette technique et risques.',
  fix: 'Lance la vérification du projet et corrige toutes les erreurs de build, de types et de lint.',
}

function greetingKeyFor(hour: number): 'greetingNight' | 'greetingMorning' | 'greetingAfternoon' | 'greetingEvening' {
  if (hour < 5) return 'greetingNight'
  if (hour < 12) return 'greetingMorning'
  if (hour < 18) return 'greetingAfternoon'
  return 'greetingEvening'
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined)
}

/**
 * Accueil MY CREATION : Bonjour / Créer / Projets récents / Todo / Modèles.
 * Aéré, desktop-first ; `.welcome` reste un contrat de test.
 */
export function HomeScreen({
  userName, workspaceName, workspacePath, analysis, analysisLoading, recentFiles,
  recentProjects, todoTasks, onPrompt, onCreate, onOpenFolder, onOpenRecentProject,
  onOpenTerminal, onOpenAnalysis, onOpenFile, onOpenTodo,
}: Props) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const time = useMemo(
    () => now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    [now],
  )
  const date = useMemo(
    () => now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    [now],
  )

  const openTodos = useMemo(() =>
    todoTasks.filter(task => task.status !== 'completed').slice(0, 4),
  [todoTasks])

  const stats = analysis
    ? [
      { label: t('home.statsFiles'), value: formatNumber(analysis.stats.files) },
      { label: t('home.statsComponents'), value: formatNumber(analysis.stats.components) },
      { label: t('home.statsLines'), value: formatNumber(analysis.stats.lines) },
      { label: t('home.statsDependencies'), value: formatNumber(analysis.dependencies.length) },
    ]
    : []

  const templates = [
    { id: 'site', icon: Globe, title: t('home.templateSite'), desc: t('home.templateSiteDesc'), prompt: TEMPLATE_PROMPTS.site },
    { id: 'api', icon: Plug, title: t('home.templateApi'), desc: t('home.templateApiDesc'), prompt: TEMPLATE_PROMPTS.api },
    { id: 'analyse', icon: Layers, title: t('home.templateAnalysis'), desc: t('home.templateAnalysisDesc'), prompt: TEMPLATE_PROMPTS.analyse },
    { id: 'fix', icon: Bug, title: t('home.templateFix'), desc: t('home.templateFixDesc'), prompt: TEMPLATE_PROMPTS.fix },
  ]

  return (
    <div className="home welcome">
      <div className="home__inner">
        <motion.div
          className="home__head"
          variants={staggerContainer(0.06)}
          initial="hidden"
          animate="visible"
        >
          <motion.span className="home__clock" variants={riseIn}>
            <Clock size={12} />
            {time} · {date}
          </motion.span>

          <motion.h1 className="home__greeting" variants={riseIn}>
            {t(`home.${greetingKeyFor(now.getHours())}`)} <span className="home__name">{userName}</span>
          </motion.h1>

          <motion.p className="home__question" variants={riseIn}>
            {t('home.subtitle')}
          </motion.p>

          <motion.div className="home__cta-row" variants={riseIn}>
            <button type="button" className="btn btn--primary btn--lg home__create" onClick={onCreate}>
              <Plus size={16} aria-hidden /> {t('home.create')}
            </button>
            {!workspacePath && (
              <button type="button" className="btn btn--secondary btn--lg" onClick={onOpenFolder}>
                <FolderOpen size={15} aria-hidden /> {t('home.openFolder')}
              </button>
            )}
          </motion.div>

          {workspacePath && (
            <motion.div className="home__workspace" variants={riseIn}>
              <span className="home__workspace-name">{workspaceName}</span>
              <span className="home__workspace-path" title={workspacePath}>{workspacePath}</span>
              {analysis && (
                <Badge tone={analysis.state === 'PASS' ? 'success' : 'danger'} size="sm">
                  {analysis.state}
                </Badge>
              )}
            </motion.div>
          )}
        </motion.div>

        <div className="home__grid">
          {recentProjects.length > 0 && (
            <motion.section
              className="home-panel home-panel--projects"
              variants={riseIn}
              initial="hidden"
              animate="visible"
            >
              <header className="home-panel__head"><span>{t('home.recentProjects')}</span></header>
              <ul className="home-projects">
                {recentProjects.slice(0, 3).map(project => (
                  <li key={project.path}>
                    <button type="button" onClick={() => onOpenRecentProject(project.path)} title={project.path}>
                      <FolderOpen size={14} aria-hidden />
                      <strong>{project.name}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </motion.section>
          )}

          <motion.section
            className="home-panel home-panel--todo"
            variants={riseIn}
            initial="hidden"
            animate="visible"
          >
            <header className="home-panel__head">
              <span>{t('home.todoToday')}</span>
              <button type="button" className="home-panel__link" onClick={onOpenTodo}>
                {t('home.viewAllTasks')}
              </button>
            </header>

            {openTodos.length === 0 ? (
              <p className="home-panel__empty">{t('home.noTasks')}</p>
            ) : (
              <ul className="home-todo">
                {openTodos.map(task => (
                  <li key={task.id} className={cx(task.status === 'in_progress' && 'is-active', task.status === 'blocked' && 'is-blocked')}>
                    {task.status === 'completed' && <CheckCircle2 size={13} aria-hidden />}
                    {task.status === 'in_progress' && <Clock size={13} aria-hidden />}
                    {task.status === 'blocked' && <ShieldAlert size={13} aria-hidden />}
                    {task.status === 'todo' && <CircleDashed size={13} aria-hidden />}
                    <span>{task.title}</span>
                    {task.priority === 'high' && <em>!</em>}
                  </li>
                ))}
              </ul>
            )}

            <div className="home-panel__row">
              <button type="button" className="home-panel__cta" onClick={onOpenTodo}>
                <ArrowRight size={13} /> {t('todo.title')}
              </button>
            </div>
          </motion.section>
        </div>

        <motion.section
          className="home-section"
          variants={riseIn}
          initial="hidden"
          animate="visible"
        >
          <header className="home-section__head"><span>{t('home.templates')}</span></header>
          <div className="home__cards">
            {templates.map(({ id, icon: Icon, title, desc, prompt }) => (
              <motion.button
                key={id}
                type="button"
                className="home-card"
                whileHover={{ y: -3 }}
                whileTap={{ y: -1 }}
                transition={transitions.fast}
                onClick={() => onPrompt(prompt)}
              >
                <span className="home-card__icon" aria-hidden><Icon size={17} /></span>
                <span className="home-card__title">{title}</span>
                <span className="home-card__desc">{desc}</span>
                <span className="home-card__go" aria-hidden><ArrowRight size={14} /></span>
              </motion.button>
            ))}
          </div>
        </motion.section>

        {(workspacePath || recentFiles.length > 0) && (
          <div className="home__columns">
            <motion.section
              className="home-panel"
              variants={riseIn}
              initial="hidden"
              animate="visible"
            >
              <header className="home-panel__head">
                <span>{t('home.projectStats')}</span>
                {workspacePath && (
                  <button type="button" className="home-panel__link" onClick={onOpenAnalysis}>
                    {t('home.fullAnalysis')}
                  </button>
                )}
              </header>

              {!workspacePath && (
                <p className="home-panel__empty">{t('home.noProjects')}</p>
              )}

              {workspacePath && analysisLoading && !analysis && (
                <div className="home-stats">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div className="home-stat" key={index}>
                      <Skeleton width="52%" height={18} />
                      <Skeleton width="70%" height={9} />
                    </div>
                  ))}
                </div>
              )}

              {analysis && (
                <>
                  <div className="home-stats">
                    {stats.map(stat => (
                      <div className="home-stat" key={stat.label}>
                        <strong>{stat.value}</strong>
                        <span>{stat.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="home-panel__meta">
                    <Badge tone="accent" size="sm">{analysis.typeLabel}</Badge>
                    {analysis.languages.slice(0, 4).map(entry => (
                      <Badge key={entry.language} size="sm">{entry.language}</Badge>
                    ))}
                  </div>
                </>
              )}
            </motion.section>

            <motion.section
              className="home-panel"
              variants={riseIn}
              initial="hidden"
              animate="visible"
            >
              <header className="home-panel__head">
                <span>{t('home.resume')}</span>
              </header>

              {recentFiles.length === 0 ? (
                <p className="home-panel__empty">{t('home.noRecentFiles')}</p>
              ) : (
                <ul className="home-recent">
                  {recentFiles.slice(0, 6).map(path => (
                    <li key={path}>
                      <button type="button" onClick={() => onOpenFile(path)} title={path}>
                        <FileCode2 size={13} />
                        <span className="home-recent__name">
                          {path.split(/[\\/]/).pop() ?? path}
                        </span>
                        <span className="home-recent__path">{path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="home-panel__row">
                <button type="button" className="home-panel__cta" onClick={onOpenTerminal}>
                  {t('statusbar.terminal')}
                </button>
                <button
                  type="button"
                  className="home-panel__cta"
                  onClick={() => onPrompt('Explique la structure de ce projet.')}
                >
                  {t('home.askAssistant')}
                </button>
              </div>
            </motion.section>
          </div>
        )}
      </div>
    </div>
  )
}
