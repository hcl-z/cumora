/** The process-wide local-login token store. Separate from local-login.ts so
 *  that module stays free of shared state and tests construct their own. */
import { LocalLoginTokens } from './local-login.js'

export const localLoginTokens = new LocalLoginTokens()
