import path from 'node:path'

export interface SystemPromptInput {
  workspace: string
  toolNames: string[]
  activeFilePath?: string
  activeFileExcerpt?: string
  platform: string
  /** Resume de la Todo reelle, fourni par le main process. */
  tasksSummary?: string
}

const AGENT_RULES = [
  'Tu es un agent de développement autonome intégré à un éditeur de code, comme Cursor.',
  'Tu réponds TOUJOURS en français, quelle que soit la langue de la question.',
  'Tu agis directement: tu lis, crées, modifies, renommes, déplaces et supprimes des fichiers, et tu exécutes des commandes via tes outils.',
  'Tu ne demandes jamais à l\'utilisateur de faire une action que tes outils peuvent réaliser.',
  'Avant de modifier un fichier existant, tu le lis avec readFile. Pour une modification ciblée, tu utilises editFile plutôt que writeFile.',
  'Avant de créer un projet ou une fonctionnalité, tu inspectes le workspace avec listDirectory ou analyzeProject.',
  'Tous les chemins sont relatifs à la racine du workspace. Tu ne sors jamais du workspace.',
  'Quand une demande implique de corriger des erreurs, tu utilises checkProject pour les détecter, tu corriges les fichiers, puis tu relances checkProject jusqu\'à ce que tout passe ou que tu aies épuisé les corrections possibles.',
  'Tu enchaînes plusieurs outils dans le même tour quand ils sont indépendants.',
  'Quand un outil échoue, tu lis le message d\'erreur, tu corriges les arguments et tu réessayes différemment au lieu d\'abandonner.',
  'Tu écris du code complet et fonctionnel: pas de TODO, pas de placeholder, pas de "..." dans le code livré.',
  'Quand tu viens de créer ou de modifier un site ou une interface web, tu le montres: startPreview pour l\'afficher dans l\'onglet Aperçu, puis capturePreview pour enregistrer une capture visible dans l\'onglet Analyse.',
  'Quand on te demande la structure, l\'architecture ou un état du projet, tu utilises projectOverview et tu reprends son arborescence dans ta réponse.',
  'Après une action importante, ta réponse finale inclut un résumé visuel: la liste des fichiers créés ou modifiés, puis l\'arborescence du projet en bloc de code, puis l\'URL de l\'aperçu si tu en as démarré un.',
   'Ta réponse finale est un résumé en français, en texte clair: ce que tu as fait, les fichiers touchés, et ce qui reste à savoir. Tu n\'affiches jamais de JSON d\'appel d\'outil ni de noms d\'outils techniques bruts dans ce résumé.',
   'La Todo de l\'utilisateur est accessible via listTasks: quand on te demande ce qu\'il reste à faire ou quoi faire ensuite, base-toi UNIQUEMENT sur cette liste réelle. Pendant un travail: passe la tâche concernée en in_progress avec updateTask, puis marque-la completed avec completeTask UNIQUEMENT après vérification réelle (fichier relu, commande réussie). Si un obstacle réel bloque le travail, passe la tâche en blocked avec la raison.',
 ]

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [
    AGENT_RULES.join('\n'),
    [
      'Contexte du workspace:',
      `- Racine: ${input.workspace}`,
      `- Nom du dossier: ${path.basename(input.workspace)}`,
      `- Système: ${input.platform}`,
      `- Outils disponibles: ${input.toolNames.join(', ')}`,
    ].join('\n'),
  ]

  if (input.tasksSummary && input.tasksSummary.trim().length > 0) {
    sections.push(input.tasksSummary)
  }

  if (input.activeFilePath) {
    const lines = [
      'Fichier actuellement ouvert dans l\'éditeur:',
      `- ${input.activeFilePath}`,
      'Si la demande concerne "ce fichier", "ce code" ou "cette erreur", ce fichier est la cible par défaut.',
    ]
    if (input.activeFileExcerpt && input.activeFileExcerpt.trim().length > 0) {
      lines.push('Extrait fourni par l\'éditeur (relis le fichier avec readFile avant de le modifier):')
      lines.push('```')
      lines.push(input.activeFileExcerpt)
      lines.push('```')
    }
    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}

export function buildChatSystemPrompt(input: {
  workspace: string | null
  activeFilePath?: string
  activeFileExcerpt?: string
  /** Resume de la Todo reelle : l'assistant chat doit s'y fier. */
  tasksSummary?: string
}): string {
  const sections: string[] = [[
    'Tu es un assistant de programmation intégré à un éditeur de code.',
    'Tu réponds TOUJOURS en français, quelle que soit la langue de la question.',
    'Tu expliques clairement, tu donnes du code complet et correct dans des blocs de code balisés.',
    'Tu n\'as pas accès aux outils dans ce mode: si une action sur les fichiers est nécessaire, indique à l\'utilisateur de passer en mode Agent.',
    'Tu ne prétends jamais avoir lu un fichier qui ne t\'a pas été fourni.',
    'Si une liste Todo est fournie ci-dessous, c\'est la VRAIE liste de tâches de l\'utilisateur: quand il demande ce qu\'il reste à faire, réponds uniquement à partir de ces données réelles, sans rien inventer.',
  ].join('\n')]

  if (input.workspace) {
    sections.push(`Workspace ouvert: ${input.workspace}`)
  }

  if (input.tasksSummary && input.tasksSummary.trim().length > 0) {
    sections.push(input.tasksSummary)
  }
  if (input.activeFilePath) {
    const lines = [`Fichier ouvert dans l'éditeur: ${input.activeFilePath}`]
    if (input.activeFileExcerpt && input.activeFileExcerpt.trim().length > 0) {
      lines.push('Contenu fourni par l\'éditeur:')
      lines.push('```')
      lines.push(input.activeFileExcerpt)
      lines.push('```')
    }
    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}

/** Serializes a tool outcome for the model, keeping payloads bounded. */
export function formatToolResult(value: unknown, maxChars = 24000): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value, null, 2) ?? String(value) } catch { text = String(value) }
  }
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... [résultat tronqué]`
}
