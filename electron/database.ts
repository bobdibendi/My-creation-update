import Database from 'better-sqlite3'
import path from 'node:path'
import fsSync from 'node:fs'
import { app } from 'electron'

let db: Database.Database | null = null

export interface User {
  id: number
  email: string
  passwordHash: string
  name: string
  createdAt: number
  /** Identité Supabase Auth (UUID) — NULL pour les comptes locaux historiques. */
  supabaseId?: string | null
}

export interface Session {
  token: string
  userId: number
  expiresAt: number
  createdAt: number
}

export interface License {
  id: number
  userId: number
  licenseKey: string
  type: string
  product: string
  version: string | null
  activatedAt: number
  expiresAt: number | null
  licenseData: string
}

/**
 * Initialize the auth database with schema.
 * Creates tables if they don't exist.
 */
export function initDatabase(): Database.Database {
  if (db) return db

  // ─── Crash diagnostics (temporary) ───────────────────
  const step = (label: string): void => console.info(`[db] SUBSTEP: ${label}`)

  const dbPath = path.join(app.getPath('userData'), 'auth.db')
  step(`chemin résolu: ${dbPath}`)
  step('userData accessible ?')
  console.info(`[db] exists=${fsSync.existsSync(dbPath)} size=${fsSync.existsSync(dbPath) ? fsSync.statSync(dbPath).size : 'n/a'}`)

  step('avant new Database() (appel natif sqlite3_open)')
  db = new Database(dbPath)
  step('new Database OK')

  // Enable foreign keys
  step('avant pragma foreign_keys')
  db.pragma('foreign_keys = ON')
  step('pragma OK')

  // Create users table
  step('avant CREATE TABLE users')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `)
  step('users OK')

  // Create sessions table
  step('avant CREATE TABLE sessions')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  step('sessions OK')

  // Create licenses table
  step('avant CREATE TABLE licenses')
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      licenseKey TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      product TEXT NOT NULL,
      version TEXT,
      activatedAt INTEGER NOT NULL,
      expiresAt INTEGER,
      licenseData TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  step('licenses OK')

  // Create indexes for performance
  step('avant CREATE INDEX')
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_licenses_userId ON licenses(userId);
  `)
  step('indexes OK')

  // Tasks table (Todo) — added without breaking existing databases.
  // userId NULL = local FREE mode without account; otherwise scoped per user.
  step('avant CREATE TABLE tasks')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      userId INTEGER,
      projectId TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      source TEXT NOT NULL DEFAULT 'user',
      blockedReason TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      completedAt INTEGER,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_userId ON tasks(userId);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `)

  // Action history (Historique) — append-only log of significant events.
  step('avant CREATE TABLE action_log')
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      detail TEXT,
      createdAt INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(createdAt DESC)')
  step('tables OK')

  // Identité Supabase : colonne nullable ajoutée sans casser les bases
  // existantes. NULL = compte local historique (créé avant Supabase Auth).
  step('avant ALTER users.supabaseId')
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!userColumns.some(column => column.name === 'supabaseId')) {
    db.exec('ALTER TABLE users ADD COLUMN supabaseId TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabaseId ON users(supabaseId) WHERE supabaseId IS NOT NULL')
  }
  step('initDatabase terminé')

  return db
}

export function getDatabase(): Database.Database {
  if (!db) return initDatabase()
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
