/**
 * AuthGate — wraps the entire app and decides whether to show the
 * sign-in screen or the real UI based on the auth store.
 *
 * Two responsibilities:
 *   1. On first mount, consume a `#token=...&companyId=...` fragment if
 *      one is present (the OAuth callback redirected us back with it).
 *      Persist the session, then scrub the URL so a reload doesn't
 *      re-arm the fragment.
 *   2. Probe /auth/me with the persisted token; if the token is valid
 *      the app loads, otherwise we fall through to AuthScreen.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { isElectron } from '@/lib/runtime'
import { AuthScreen } from './AuthScreen'
import { WindowDragStrip } from './WindowDragStrip'

interface AuthGateProps {
  children: ReactNode
  /** Override the "no token" rendering. The invite-accept flow uses this
   *  so an unauthenticated visitor sees the invitation card (with sign-in
   *  buttons embedded) instead of the bare login screen. */
  unauthFallback?: ReactNode
}

interface CarriedSession { token: string; companyId: string | null }

/** Pull a fresh OAuth token out of `location.hash`. Returns null if the
 *  fragment is empty or has no token. On success, scrubs the fragment so
 *  the token never lingers in the browser address bar. */
function consumeOAuthFragment(): CarriedSession | null {
  const hash = location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = params.get('token')
  if (!token) return null
  const companyId = params.get('companyId')
  // Replace the URL without ?#... so refresh/reopen doesn't re-process.
  history.replaceState(null, '', location.pathname + location.search)
  return { token, companyId }
}


/** Personal-mode dev login (`#login=<one-time token>`, printed by the server at
 *  boot). Read once at module load and scrubbed immediately, and the exchange
 *  promise is shared, so StrictMode's double-run effects spend the single-use
 *  token only once. */
const pendingLocalLogin: string | null = (() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const t = params.get('login')
  if (!t) return null
  history.replaceState(null, '', location.pathname + location.search)
  return t
})()
let localLoginExchange: Promise<CarriedSession | null> | null = null
function exchangeLocalLogin(): Promise<CarriedSession | null> | null {
  if (!pendingLocalLogin) return null
  localLoginExchange ??= api.authLocalLogin(pendingLocalLogin)
    .then((r) => ({ token: r.token, companyId: r.companyId }))
    .catch(() => null)
  return localLoginExchange
}

export function AuthGate({ children, unauthFallback }: AuthGateProps) {
  const token = useAuth((s) => s.token)
  const ready = useAuth((s) => s.ready)
  const [localLoginPending, setLocalLoginPending] = useState(() => pendingLocalLogin !== null)
  const setSession = useAuth((s) => s.setSession)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const clear = useAuth((s) => s.clear)
  const markReady = useAuth((s) => s.markReady)

  // Run-once: consume the OAuth fragment before the probe effect sees
  // `token` and decides what to do. useState init runs synchronously
  // before any effect, so the auth store has the new token in time.
  useState(() => {
    const carried = consumeOAuthFragment()
    if (carried) {
      // setMe runs on the /auth/me probe right below. For now just plant
      // a placeholder user so setSession's WS-reconnect call has a valid
      // token; the probe will fill in the rest.
      setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
    }
    return null
  })

  useEffect(() => {
    let cancelled = false
    if (!token) { markReady(); return }
    void (async () => {
      try {
        const r = await api.authMe()
        if (cancelled) return
        setMe(r.user, r.companies, r.activeCompanyId)
        setServerCapabilities(r.serverCapabilities)
        markReady()
      } catch {
        // Token's bad / expired — clear and route to login.
        if (!cancelled) clear()
      }
    })()
    return () => { cancelled = true }
  }, [token, setMe, setServerCapabilities, clear, markReady])

  useEffect(() => {
    const exchange = exchangeLocalLogin()
    if (!exchange) return
    let cancelled = false
    void exchange.then((carried) => {
      if (cancelled) return
      if (carried) {
        setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
      } else {
        // Same `#error=` fragment the OAuth callback uses, so AuthScreen shows it.
        history.replaceState(null, '', `${location.pathname}${location.search}#error=local_login_invalid`)
      }
      setLocalLoginPending(false)
    })
    return () => { cancelled = true }
  }, [setSession])

  // Electron-only: listen for OAuth tokens forwarded by the main
  // process. The user clicked "Continue with Google" → we opened the
  // system browser → provider redirected through our server to
  // http://127.0.0.1:47823/auth/done → loopback page POSTed the
  // parsed fragment to /auth/token → main IPC'd here. Plant the
  // session and trip the /auth/me probe by setting token.
  useEffect(() => {
    if (!isElectron || !window.cumora?.auth) return
    const off = window.cumora.auth.onToken(({ token: t, companyId }) => {
      if (!t) return
      setSession(t, { id: '', email: '', name: '' }, companyId)
    })
    return off
  }, [setSession])

  // Native (iOS / Android): when the SFSafariViewController flow
  // completes, lib/native.ts plants the token fragment on our location
  // and fires `cumora:oauth-token`. Consume it the same way as the
  // top-of-mount `consumeOAuthFragment` so AuthGate's existing probe
  // logic picks up the new token.
  useEffect(() => {
    const handler = () => {
      const carried = consumeOAuthFragment()
      if (!carried) return
      setSession(carried.token, { id: '', email: '', name: '' }, carried.companyId)
    }
    window.addEventListener('cumora:oauth-token', handler)
    return () => window.removeEventListener('cumora:oauth-token', handler)
  }, [setSession])

  if (!ready || localLoginPending) {
    // Brief loading flash while we probe — keeps the app from flashing
    // login → main on a valid token reload.
    return (
      <div
        className="fixed inset-0 grid place-items-center text-ink-300 font-display italic text-[13px]"
        style={{ background: 'var(--paper)' }}
      ><WindowDragStrip />loading…</div>
    )
  }

  if (!token) return <>{unauthFallback ?? <AuthScreen />}</>
  return <>{children}</>
}
