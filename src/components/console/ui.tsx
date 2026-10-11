/**
 * Shared primitives for the personal console (docs/personal-bot/
 * mvp-frontend-design.md §8). Styles follow ShippingWorkspace so the console
 * reads like the rest of the app; used only inside components/console.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Button({ children, onClick, disabled, tone = 'default', type = 'button', className }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger' | 'success'
  type?: 'button' | 'submit'
  className?: string
}) {
  const tones = {
    default: 'border-ink-100 bg-cloud text-ink-700 hover:bg-sky2-50',
    primary: 'border-skype bg-skype text-white hover:bg-skype-deep',
    danger: 'border-coral/30 bg-coral-soft/30 text-coral-deep hover:bg-coral-soft/60',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn('rounded-lg border px-3 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45', tones[tone], className)}
    >
      {children}
    </button>
  )
}

export type PillTone = 'neutral' | 'good' | 'bad' | 'warn' | 'blue'

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: PillTone }) {
  const colors: Record<PillTone, string> = {
    neutral: 'bg-ink-50 text-ink-600',
    good: 'bg-emerald-50 text-emerald-700',
    bad: 'bg-coral-soft/40 text-coral-deep',
    warn: 'bg-gold/15 text-amber-700',
    blue: 'bg-sky2-50 text-skype-deep',
  }
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em]', colors[tone])}>{children}</span>
}

/** An accessible on/off switch (role="switch"), styled like the mobile
 *  preference toggles. */
export function Switch({ checked, onChange, label, description, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-xl px-1 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-tight text-ink-900">{label}</span>
        {description && <span className="mt-0.5 block text-[11px] text-ink-500">{description}</span>}
      </span>
      <span aria-hidden className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-skype' : 'bg-ink-200')}>
        <span
          className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')}
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}
        />
      </span>
    </button>
  )
}

export function Section({ title, eyebrow, children, action }: { title: string; eyebrow?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border border-ink-100 bg-cloud p-4 shadow-soft md:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          {eyebrow && <div className="text-[9px] font-bold uppercase tracking-[.18em] text-skype-deep">{eyebrow}</div>}
          <h2 className="mt-1 text-[15px] font-semibold text-ink-900">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Loading / empty / failed placeholder, with an optional retry. */
export function Centered({ title, detail, retry, retryLabel, icon }: {
  title: string
  detail?: string
  retry?: () => void
  retryLabel?: string
  icon?: ReactNode
}) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        {icon}
        <div className="mt-3 text-[13px] font-semibold text-ink-700">{title}</div>
        {detail && <p className="mt-2 max-w-md text-[11px] text-ink-500">{detail}</p>}
        {retry && <Button onClick={retry} className="mt-3">{retryLabel}</Button>}
      </div>
    </div>
  )
}

/** Inline error, announced to assistive technology. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="mt-3 rounded-xl border border-coral/20 bg-coral-soft/20 px-3 py-2 text-[11px] text-coral-deep">{children}</div>
}
