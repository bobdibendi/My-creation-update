import type { AIProvider, ProviderEvent } from './providers/registry.js'
import { isAbort } from './providers/http.js'
import { isTransientError } from './errors.js'

/**
 * Chaîne de repli entre fournisseurs intégrés.
 *
 * Règles :
 *   - seul un fournisseur PRINCIPAL est tenté en premier ;
 *   - on bascule UNIQUEMENT sur une erreur temporaire (429, 5xx, réseau,
 *     timeout) ET avant qu'aucun octet n'ait été diffusé au renderer —
 *     jamais au milieu d'une réponse, donc jamais de doublon ;
 *   - les erreurs définitives (401/403, requête invalide, quota épuisé) sont
 *     remontées telles quelles : changer de modèle ne les corrigerait pas.
 */
export class ProviderFallbackManager {
  constructor(private readonly chain: AIProvider[]) {}

  /** Tente chaque fournisseur dans l'ordre jusqu'à une réponse exploitable. */
  async stream(request: Parameters<AIProvider['stream']>[0], onEvent: (event: ProviderEvent) => void): Promise<void> {
    if (this.chain.length === 0) throw new Error('Aucun fournisseur disponible')

    let emitted = false
    let lastError: unknown = null

    for (let index = 0; index < this.chain.length; index += 1) {
      const provider = this.chain[index]
      // Chaque fournisseur reçoit SON propre modèle : un model id
      // n'a pas de sens chez un autre backend.
      const adaptedRequest = index === 0 || request.model === undefined
        ? request
        : { ...request, model: provider.models[0]?.id ?? request.model }
      const failure = await this.runOne(provider, adaptedRequest, event => {
        // Le premier contenu fige la chaîne : plus aucun basculement possible.
        if (event.type === 'text' || event.type === 'tool-call') emitted = true
        onEvent(event)
      })
      if (failure === null) return

      lastError = failure
      if (isAbort(failure)) return
      if (emitted || !isTransientError(failure)) break
      if (index < this.chain.length - 1) {
        console.warn(`[fallback] ${provider.name} indisponible (${failure instanceof Error ? failure.message : failure}), bascule vers ${this.chain[index + 1].name}`)
      }
    }

    throw lastError ?? new Error('Tous les fournisseurs ont échoué')
  }

  /**
   * Exécute un fournisseur et retourne null si le flux s'est terminé
   * normalement, sinon l'erreur rencontrée. Les événements sont transmis tels
   * quels ; l'erreur est interceptée AVANT le renderer pour permettre le choix.
   */
  private async runOne(
    provider: AIProvider,
    request: Parameters<AIProvider['stream']>[0],
    onEvent: (event: ProviderEvent) => void,
  ): Promise<unknown> {
    return new Promise<unknown>(resolve => {
      let settled = false
      const finish = (error: unknown): void => {
        if (settled) return
        settled = true
        resolve(error)
      }

      try {
        void provider.stream(request, event => {
          if (event.type === 'error') {
            finish(new Error(event.message))
            return
          }
          if (event.type === 'done') {
            finish(null)
          }
          onEvent(event)
        }).then(
          () => finish(null),
          error => finish(error),
        )
      } catch (error: unknown) {
        finish(error)
      }
    })
  }
}
