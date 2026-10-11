/**
 * The personal console (工作台, docs/personal-bot/mvp-frontend-design.md §2,
 * §3). One component for both layouts, like ShippingWorkspace: `compact`
 * stacks list and detail for mobile. T08 ships the Connectors tab only; the
 * capability, approval, run and control tabs arrive with their tasks.
 */
import { useState } from 'react'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ConnectorsTab } from './ConnectorsTab'

const tabs = [
  { key: 'connectors', label: 'console.tab.connectors' },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey }>

type Tab = (typeof tabs)[number]['key']

export function ConsoleWorkspace({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('connectors')
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ship-canvas)]">
      <header className="border-b border-ink-100 bg-cloud px-4 pt-4">
        <h1 className="text-[18px] font-semibold text-ink-900">{t('nav.console')}</h1>
        <p className="mt-0.5 text-[11px] text-ink-400">{t('console.subtitle')}</p>
        <div role="tablist" aria-label={t('nav.console')} className="mt-3 flex gap-4">
          {tabs.map((it) => (
            <button
              key={it.key}
              type="button"
              role="tab"
              aria-selected={tab === it.key}
              onClick={() => setTab(it.key)}
              className={cn(
                'border-b-2 pb-2 text-[12.5px] font-semibold transition',
                tab === it.key ? 'border-skype text-skype-deep' : 'border-transparent text-ink-500 hover:text-ink-800',
              )}
            >
              {t(it.label)}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {tab === 'connectors' && <ConnectorsTab compact={compact} />}
      </div>
    </div>
  )
}
