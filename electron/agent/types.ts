import type { JsonSchemaObject } from '../providers/registry.js'

export interface ToolContext {
  /** Absolute path of the opened folder. Every path argument resolves inside it. */
  workspace: string
  signal: AbortSignal
  /** Streams human-readable progress while a long tool runs. */
  onProgress(text: string): void
}

export interface Tool {
  name: string
  description: string
  parameters: JsonSchemaObject
  /** True when the tool writes to disk, so the UI can refresh the explorer. */
  mutates: boolean
  execute(args: unknown, context: ToolContext): Promise<unknown>
}

export type ToolResult =
  | { success: true; result: unknown }
  | { success: false; error: string }
