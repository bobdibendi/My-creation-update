import type { JsonSchemaObject } from '../providers/registry.js'

/** Tool arguments arrive as untrusted JSON produced by a model. */
export function asRecord(args: unknown, tool: string): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Les arguments de ${tool} doivent être un objet JSON`)
  }
  return args as Record<string, unknown>
}

export function requireString(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Argument "${name}" manquant ou vide`)
  }
  return value
}

export function requireText(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string') throw new Error(`Argument "${name}" manquant (chaîne attendue)`)
  return value
}

export function optionalString(record: Record<string, unknown>, name: string, fallback: string): string {
  const value = record[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`Argument "${name}" doit être une chaîne`)
  return value.trim().length === 0 ? fallback : value
}

export function optionalBoolean(record: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = record[name]
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Argument "${name}" doit être un booléen`)
}

export function optionalNumber(record: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = record[name]
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Argument "${name}" doit être un nombre`)
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

export function objectSchema(
  properties: JsonSchemaObject['properties'],
  required: string[] = [],
): JsonSchemaObject {
  return { type: 'object', properties, required, additionalProperties: false }
}
