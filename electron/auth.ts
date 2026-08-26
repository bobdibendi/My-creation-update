import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { getDatabase, type User, type Session } from './database.js'

const BCRYPT_ROUNDS = 10
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface RegisterInput {
  email: string
  password: string
  name: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface AuthResult {
  success: boolean
  error?: string
  user?: Omit<User, 'passwordHash'>
  sessionToken?: string
}

export interface SessionInfo {
  user: Omit<User, 'passwordHash'>
  expiresAt: number
}

/** Identité vérifiée côté Supabase, miroir dans la base locale. */
export interface SupabaseIdentityInput {
  supabaseId: string
  email: string
  name?: string | null
}

/**
 * AuthService handles user registration, login, logout, and session management.
 */
export class AuthService {
  private db = getDatabase()

  /**
   * Register a new user account.
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    // Validate email format
    if (!this.isValidEmail(input.email)) {
      return { success: false, error: 'Adresse email invalide' }
    }

    // Validate password strength
    if (input.password.length < 8) {
      return { success: false, error: 'Le mot de passe doit contenir au moins 8 caractères' }
    }

    // Check if user already exists
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(input.email)
    if (existing) {
      return { success: false, error: 'Un compte avec cet email existe déjà' }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)

    // Insert user
    try {
      const result = this.db
        .prepare('INSERT INTO users (email, passwordHash, name, createdAt) VALUES (?, ?, ?, ?)')
        .run(input.email, passwordHash, input.name, Date.now())

      const userId = result.lastInsertRowid as number

      // Create session
      const sessionToken = this.generateSessionToken()
      const expiresAt = Date.now() + SESSION_DURATION_MS

      this.db
        .prepare('INSERT INTO sessions (token, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
        .run(sessionToken, userId, expiresAt, Date.now())

      const user = {
        id: userId,
        email: input.email,
        name: input.name,
        createdAt: Date.now(),
      }

      return {
        success: true,
        user,
        sessionToken,
      }
    } catch {
      return { success: false, error: 'Erreur lors de la création du compte' }
    }
  }

  /**
   * Login with email and password.
   */
  async login(input: LoginInput): Promise<AuthResult> {
    const user = this.db
      .prepare('SELECT id, email, passwordHash, name, createdAt FROM users WHERE email = ?')
      .get(input.email) as User | undefined

    if (!user) {
      return { success: false, error: 'Email ou mot de passe incorrect' }
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash)
    if (!valid) {
      return { success: false, error: 'Email ou mot de passe incorrect' }
    }

    // Clean expired sessions
    this.cleanExpiredSessions()

    // Create new session
    const sessionToken = this.generateSessionToken()
    const expiresAt = Date.now() + SESSION_DURATION_MS

    this.db
      .prepare('INSERT INTO sessions (token, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
      .run(sessionToken, user.id, expiresAt, Date.now())

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
      sessionToken,
    }
  }

  /**
   * Logout by invalidating a session token.
   */
  logout(sessionToken: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionToken)
  }

  /**
   * Verify a session token and return user info if valid.
   */
  verifySession(sessionToken: string): SessionInfo | null {
    const session = this.db
      .prepare(
        `
      SELECT s.expiresAt, u.id, u.email, u.name, u.createdAt
      FROM sessions s
      JOIN users u ON s.userId = u.id
      WHERE s.token = ?
    `,
      )
      .get(sessionToken) as (Session & Omit<User, 'passwordHash'>) | undefined

    if (!session) return null

    // Check expiration
    if (session.expiresAt < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionToken)
      return null
    }

    return {
      user: {
        id: session.id,
        email: session.email,
        name: session.name,
        createdAt: session.createdAt,
      },
      expiresAt: session.expiresAt,
    }
  }

  /**
   * Get user by ID.
   */
  getUserById(userId: number): Omit<User, 'passwordHash'> | null {
    const user = this.db
      .prepare('SELECT id, email, name, createdAt FROM users WHERE id = ?')
      .get(userId) as Omit<User, 'passwordHash'> | undefined

    return user ?? null
  }

  /**
   * Met à jour le profil (nom et/ou e-mail) du compte authentifié.
   * Réel : écrit dans SQLite, contrainte d'unicité e-mail respectée.
   */
  updateProfile(
    userId: number,
    changes: { name?: string; email?: string },
  ): { success: boolean; error?: string; user?: Omit<User, 'passwordHash'> } {
    const user = this.getUserById(userId)
    if (!user) return { success: false, error: 'Session invalide' }

    const newName = typeof changes.name === 'string' ? changes.name.trim() : undefined
    const newEmail = typeof changes.email === 'string' ? changes.email.trim().toLowerCase() : undefined

    if (newName !== undefined && newName.length === 0) {
      return { success: false, error: 'Le nom ne peut pas être vide' }
    }
    if (newEmail !== undefined && !this.isValidEmail(newEmail)) {
      return { success: false, error: 'Adresse e-mail invalide' }
    }

    try {
      if (newEmail && newEmail !== user.email) {
        const taken = this.db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, userId)
        if (taken) return { success: false, error: 'Un compte utilise déjà cet e-mail' }
        // Les sessions restent valides : seul l'e-mail affiché change.
        this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, userId)
      }
      if (newName && newName !== user.name) {
        this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(newName, userId)
      }
      return { success: true, user: this.getUserById(userId)! }
    } catch {
      return { success: false, error: 'Erreur lors de la mise à jour du profil' }
    }
  }

  /**
   * Change le mot de passe : vérifie l'ancien (bcrypt), stocke uniquement le
   * nouveau hash, et révoque toutes les AUTRES sessions du compte.
   * Le mot de passe en clair n'est jamais persisté ni journalisé.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; error?: string; sessionToken?: string }> {
    const row = this.db
      .prepare('SELECT id, passwordHash FROM users WHERE id = ?')
      .get(userId) as Pick<User, 'id' | 'passwordHash'> | undefined
    if (!row) return { success: false, error: 'Session invalide' }

    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return { success: false, error: 'Ancien mot de passe requis' }
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return { success: false, error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' }
    }

    const valid = await bcrypt.compare(currentPassword, row.passwordHash)
    if (!valid) return { success: false, error: 'Ancien mot de passe incorrect' }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    this.db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, userId)
    // Sécurité : les autres sessions ouvertes sont invalidées.
    this.db.prepare('DELETE FROM sessions WHERE userId = ?').run(userId)
    // La session courante est recréée et retournée à l'appelant.
    const sessionToken = this.generateSessionToken()
    this.db
      .prepare('INSERT INTO sessions (token, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
      .run(sessionToken, userId, Date.now() + SESSION_DURATION_MS, Date.now())

    return { success: true, sessionToken }
  }

  /**
   * Clean expired sessions from database.
   */
  private cleanExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now())
  }

  /**
   * Pont Supabase : l'utilisateur Supabase devient l'identité du compte local.
   *
   * L'authentification (mot de passe, confirmation email) est faite par
   * Supabase Auth ; ici on garantit uniquement qu'une ligne `users` existe
   * pour cette identité et on renvoie une session SQLite, afin que toute la
   * chaîne existante (licences, quotas, tâches) continue de fonctionner
   * sans modification.
   */
  async ensureSupabaseUser(input: SupabaseIdentityInput): Promise<AuthResult> {
    const supabaseId = String(input.supabaseId).trim()
    const email = String(input.email).trim().toLowerCase()
    const name = (input.name ?? '').toString().trim() || email.split('@')[0] || 'Utilisateur'

    if (!supabaseId || !this.isValidEmail(email)) {
      return { success: false, error: 'Identité Supabase invalide' }
    }

    try {
      // 1) Déjà miroir ? -> simple session.
      let row = this.db.prepare('SELECT id FROM users WHERE supabaseId = ?').get(supabaseId) as { id: number } | undefined

      // 2) Compte local préexistant avec le même email -> liaison.
      if (!row) {
        const byEmail = this.db
          .prepare('SELECT id FROM users WHERE email = ? AND supabaseId IS NULL')
          .get(email) as { id: number } | undefined
        if (byEmail) {
          this.db.prepare('UPDATE users SET supabaseId = ? WHERE id = ?').run(supabaseId, byEmail.id)
          row = byEmail
        }
      }

      // 3) Nouveau compte -> FREE par défaut, aucune licence.
      if (!row) {
        // Mot de passe local inutilisable : seul Supabase authentifie ce compte.
        const unusableHash = await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS)
        const result = this.db
          .prepare('INSERT INTO users (email, passwordHash, name, createdAt, supabaseId) VALUES (?, ?, ?, ?, ?)')
          .run(email, unusableHash, name, Date.now(), supabaseId)
        row = { id: result.lastInsertRowid as number }
      }

      const user = this.getUserById(row.id)
      if (!user) return { success: false, error: 'Erreur lors de la synchronisation du compte' }

      this.cleanExpiredSessions()
      const sessionToken = this.generateSessionToken()
      this.db
        .prepare('INSERT INTO sessions (token, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
        .run(sessionToken, user.id, Date.now() + SESSION_DURATION_MS, Date.now())

      return { success: true, user, sessionToken }
    } catch {
      return { success: false, error: 'Erreur lors de la synchronisation du compte' }
    }
  }

  /**
   * Generate a cryptographically secure session token.
   */
  private generateSessionToken(): string {
    return randomBytes(32).toString('hex')
  }

  /**
   * Basic email validation.
   */
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }
}
