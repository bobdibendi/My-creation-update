import type { ToolSchema } from '../providers/registry.js'
import type { Tool, ToolContext, ToolResult } from './types.js'
import { createFilesystemTools } from './tools/filesystem.js'
import { createTerminalTools } from './tools/terminal.js'
import { createAnalysisTools } from './tools/analysis.js'
import { createPreviewTools, type PreviewToolBridge } from './tools/preview.js'
import { createTaskTools, type TaskToolBridge } from './tools/tasks.js'

/** Registry of every tool the agent may call. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[] = defaultTools()) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: Tool): void {
    if (tool.name.trim().length === 0) throw new Error('Le nom d\'un outil ne peut pas être vide')
    if (this.tools.has(tool.name)) throw new Error(`Outil déjà enregistré: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return Array.from(this.tools.values())
  }

  names(): string[] {
    return Array.from(this.tools.keys())
  }

  schemas(): ToolSchema[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  /** Executes a tool call, converting any failure into a result the model can read. */
  async execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) {
      return { success: false, error: `Outil inconnu: ${name}. Outils disponibles: ${this.names().join(', ')}` }
    }

    let args: unknown
    try {
      args = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments)
    } catch (error: unknown) {
      return {
        success: false,
        error: `Arguments JSON invalides pour ${name}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    try {
      return { success: true, result: await tool.execute(args, context) }
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Every tool the agent gets by default.
 *
 * `previewBridge` lets the application share its own preview manager, so a
 * preview the agent starts appears in the Preview tab instead of running in an
 * invisible second instance. `taskBridge` scopes the Todo tools to the
 * account of the current session (null = local mode without account).
 */
export function defaultTools(previewBridge?: PreviewToolBridge, taskBridge?: TaskToolBridge): Tool[] {
  return [
    ...createFilesystemTools(),
    ...createTerminalTools(),
    ...createAnalysisTools(),
    ...createPreviewTools(previewBridge),
    ...(taskBridge ? createTaskTools(taskBridge) : []),
  ]
}
