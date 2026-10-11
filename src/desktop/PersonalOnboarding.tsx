import { useEffect, useState } from 'react'
import { useComputers } from '@/stores/computers'
import { TitleBar } from '@/desktop/TitleBar'
import { useT } from '@/lib/i18n'

/** How long to wait for the bundled daemon before showing what to check. */
const HOST_WAIT_HINT_MS = 60_000

/**
 * Personal-mode first run (mvp-frontend-design §7). The deployment's daemon
 * pairs itself with the bootstrap secret, so there is no code to copy: this
 * screen only waits. AuthedApp clears the gate when the computer comes online,
 * which drops the owner into 总群 with the Chief bot.
 */
export function PersonalOnboarding() {
  const t = useT()
  const [slow, setSlow] = useState(false)

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), HOST_WAIT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="flex flex-col h-screen">
      <TitleBar />
      <main className="flex-1 overflow-y-auto grid place-items-center p-8"
        style={{ background: 'linear-gradient(180deg, var(--paper), var(--sky-50))' }}>
        <div className="w-full max-w-[560px]">
          <h1 className="font-display font-medium text-[32px] tracking-tight text-ink-900 mb-2" style={{ letterSpacing: '-0.02em' }}>
            {t('personalOnboard.title')}
          </h1>
          <p className="text-[14.5px] text-ink-600 leading-relaxed mb-6">{t('personalOnboard.body')}</p>
          <div className="bg-cloud rounded-[16px] p-5" style={{ border: '1px solid var(--ink-100)' }}>
            <div className="flex items-center gap-2.5" role="status" aria-live="polite">
              <span className="inline-block w-2 h-2 rounded-full bg-gold animate-pulse" aria-hidden="true" />
              <span className="text-[13.5px] font-semibold text-ink-900">{t('personalOnboard.waiting')}</span>
            </div>
            {slow && (
              <div className="mt-4 text-[12.5px] text-ink-600 leading-relaxed">
                <div className="font-semibold text-ink-900 mb-1">{t('personalOnboard.slowTitle')}</div>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('personalOnboard.slowRunning')}</li>
                  <li>{t('personalOnboard.slowToken')}</li>
                  <li>{t('personalOnboard.slowLogs')}</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
