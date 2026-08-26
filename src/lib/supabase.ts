/**
 * Client Supabase unique de l'application.
 *
 * Les variables proviennent de l'environnement Vite (fichier .env.local,
 * jamais commité) — aucune valeur n'est codée en dur ici. La clé
 * publishable est publique par conception ; aucun secret service_role /
 * database password ne doit JAMAIS être présent côté renderer.
 */
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Configuration Supabase manquante : définissez VITE_SUPABASE_URL et '
    + 'VITE_SUPABASE_PUBLISHABLE_KEY dans .env.local (voir README).',
  )
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    // Le renderer Electron est un contexte persistant : la session survit au
    // redémarrage via localStorage et est restaurée par getSession().
    persistSession: true,
    autoRefreshToken: true,
    // Le retour de confirmation e-mail n'arrive JAMAIS dans ce contexte (il
    // s'ouvre dans le navigateur externe puis revient par deep link
    // « mycreation:// ») : la détection automatique serait morte et pourrait
    // consommer un callback deux fois. Traitée manuellement, une seule fois,
    // dans src/lib/authCallback.ts.
    detectSessionInUrl: false,
    // Flux PKCE explicite : le lien de confirmation renvoie un code
    // d'autorisation échangé côté application par exchangeCodeForSession()
    // avec le verifier stocké ici au moment du signUp().
    flowType: 'pkce',
  },
})
