/**
 * Connectors tab (docs/personal-bot/mvp-frontend-design.md §3.2).
 *
 * Adding a connector is three steps: pick a source (YAML you write, or an
 * OpenAPI document), review each action's read/write marking, then set
 * credentials and try a read action. Step 1 is the create form; steps 2 and
 * 3 are the draft's detail page, with a progress strip on top. A bot's draft
 * (`cumora connector draft`) opens straight at step 2.
 *
 * Every imported or bot-proposed action starts as write. Only GET/HEAD
 * actions can be downgraded to read, and a connector cannot be enabled until
 * the user has confirmed the marking.
 */
import { useEffect, useState } from 'react'
import {
  type ApiConnector, type ApiConnectorAction, type ApiConnectorDetail, type ApiConnectorSource, type ApiConnectorStatus,
  type ApiConnectorTestResult, ApiError, api,
} from '@/api/client'
import { Input } from '@/components/Input'
import { canSeal, sealCredential } from '@/lib/vault-seal'
import { IBack, IPlus } from '@/components/icons'
import { TextArea } from '@/components/TextArea'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useConnectors } from '@/stores/connectors'
import { Button, Centered, ErrorNote, Pill, type PillTone, Section, Switch } from './ui'

const STATUS: Record<ApiConnectorStatus, { label: MessageKey; tone: PillTone }> = {
  draft: { label: 'connector.status.draft', tone: 'warn' },
  active: { label: 'connector.status.active', tone: 'good' },
  disabled: { label: 'connector.status.disabled', tone: 'neutral' },
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

const YAML_PLACEHOLDER = `id: market-data
name: Market data
base_url: https://api.example.com/v1
actions:
  - id: quote
    effect: read
    method: GET
    path: /quote/{symbol}
    params: { symbol: string }`

type ParamSpec = { type?: string; required?: boolean; description?: string }

function needsReview(c: ApiConnector): boolean {
  return c.actions.some((a) => !a.effectConfirmed)
}

export function ConnectorsTab({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const connectors = useConnectors((s) => s.connectors)
  const loaded = useConnectors((s) => s.loaded)
  const loading = useConnectors((s) => s.loading)
  const error = useConnectors((s) => s.error)
  const selectedId = useConnectors((s) => s.selectedId)
  const detail = useConnectors((s) => (s.selectedId ? s.details[s.selectedId] : undefined))
  const load = useConnectors((s) => s.load)
  const select = useConnectors((s) => s.select)
  const [creating, setCreating] = useState(false)

  useEffect(() => { void load() }, [load])

  if (!loaded && loading) return <Centered title={t('connector.loading')} />
  if (!loaded) return <Centered title={t('connector.unavailable')} detail={error ?? undefined} retry={() => void load(true)} retryLabel={t('connector.retry')} />

  const showList = !compact || (!selectedId && !creating)
  const showDetail = !compact || Boolean(selectedId) || creating
  return (
    <div className={cn('h-full min-h-0', compact ? 'relative overflow-hidden' : 'grid grid-cols-[300px_minmax(0,1fr)]')}>
      {showList && (
        <aside className={cn('h-full overflow-y-auto border-r border-ink-100 bg-cloud', compact && 'absolute inset-0 border-r-0')}>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[12px] font-semibold text-ink-700">{t('connector.listTitle', { n: connectors.length })}</span>
            <button
              type="button"
              onClick={() => { setCreating(true); void select(null) }}
              className="grid h-8 w-8 place-items-center rounded-xl bg-skype text-white shadow-soft"
              aria-label={t('connector.new')}
              title={t('connector.new')}
            >
              <IPlus className="h-4 w-4" />
            </button>
          </div>
          <div className="px-2 pb-2">
            {connectors.map((c) => <ConnectorRow key={c.id} connector={c} active={selectedId === c.id && !creating} onClick={() => { setCreating(false); void select(c.id) }} />)}
            {connectors.length === 0 && (
              <div className="px-6 py-14 text-center">
                <div className="text-[13px] font-semibold text-ink-700">{t('connector.empty')}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{t('connector.emptyDetail')}</p>
              </div>
            )}
          </div>
        </aside>
      )}
      {showDetail && (
        <main className={cn('h-full min-w-0 overflow-y-auto', compact && 'absolute inset-0 bg-[var(--ship-canvas)]')}>
          {compact && (
            <button
              type="button"
              onClick={() => { setCreating(false); void select(null) }}
              className="sticky top-0 z-20 flex h-11 w-full items-center gap-1 border-b border-ink-100 bg-cloud/95 px-3 text-[12px] font-semibold text-skype-deep backdrop-blur"
            >
              <IBack className="h-4 w-4" /> {t('connector.all')}
            </button>
          )}
          {creating
            ? <CreateConnector onDone={() => setCreating(false)} />
            : detail
              ? <ConnectorDetail connector={detail} />
              : <Centered title={selectedId ? t('connector.opening') : t('connector.pickOne')} />}
        </main>
      )}
    </div>
  )
}

function ConnectorRow({ connector, active, onClick }: { connector: ApiConnector; active: boolean; onClick: () => void }) {
  const t = useT()
  const status = STATUS[connector.status]
  const botDraft = connector.createdByKind === 'bot' && connector.status === 'draft'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('mb-1 w-full rounded-xl px-3 py-3 text-left transition', active ? 'bg-sky2-50 ring-1 ring-sky2-200' : 'hover:bg-ink-50')}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink-900">{connector.name ?? connector.slug}</span>
        <Pill tone={status.tone}>{t(status.label)}</Pill>
      </div>
      <div className="mt-1 truncate text-[10.5px] text-ink-400">
        {connector.slug} · {t('connector.actionCount', { n: connector.actions.length })}
        {connector.adhocRead && ` · ${t('connector.adhocShort')}`}
      </div>
      {botDraft && <div className="mt-1.5 text-[10.5px] font-semibold text-amber-700">{t('connector.botDraftShort')}</div>}
    </button>
  )
}

// ── step 1: source ──────────────────────────────────────────────────────

type SourceKind = 'yaml' | 'openapiUrl' | 'openapiSpec'

function CreateConnector({ onDone }: { onDone: () => void }) {
  const t = useT()
  const create = useConnectors((s) => s.create)
  const saving = useConnectors((s) => s.saving)
  const error = useConnectors((s) => s.error)
  const [kind, setKind] = useState<SourceKind>('yaml')
  const [text, setText] = useState('')
  const [slug, setSlug] = useState('')
  const [adhocRead, setAdhocRead] = useState(false)
  const source = (): ApiConnectorSource => {
    if (kind === 'yaml') return { yaml: text }
    const extra = slug.trim() ? { slug: slug.trim() } : {}
    return kind === 'openapiUrl' ? { openapi: { url: text.trim(), ...extra } } : { openapi: { spec: text, ...extra } }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    if (await create({ ...source(), adhocRead })) onDone()
  }
  const tabs: Array<{ id: SourceKind; label: MessageKey }> = [
    { id: 'yaml', label: 'connector.source.yaml' },
    { id: 'openapiUrl', label: 'connector.source.openapiUrl' },
    { id: 'openapiSpec', label: 'connector.source.openapiSpec' },
  ]
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-[860px] px-4 py-5 md:px-7">
      <Progress step={1} />
      <Section title={t('connector.newTitle')} eyebrow={t('connector.newEyebrow')}>
        <div role="radiogroup" aria-label={t('connector.sourceLabel')} className="mb-3 flex flex-wrap gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="radio"
              aria-checked={kind === tab.id}
              onClick={() => { setKind(tab.id); setText('') }}
              className={cn(
                'min-h-[36px] rounded-lg border px-3 text-[12px] font-semibold transition',
                kind === tab.id ? 'border-skype bg-sky2-50 text-skype-deep' : 'border-ink-100 bg-cloud text-ink-600 hover:bg-ink-50',
              )}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
        {kind === 'openapiUrl' ? (
          <>
            <label htmlFor="connector-source" className="text-[11px] font-semibold text-ink-600">{t('connector.openapiUrlLabel')}</label>
            <Input
              id="connector-source"
              type="url"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="https://api.example.com/openapi.json"
              spellCheck={false}
              className="mt-1"
              autoFocus
            />
          </>
        ) : (
          <>
            <label htmlFor="connector-source" className="text-[11px] font-semibold text-ink-600">
              {t(kind === 'yaml' ? 'connector.yamlLabel' : 'connector.openapiSpecLabel')}
            </label>
            <TextArea
              id="connector-source"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={kind === 'yaml' ? YAML_PLACEHOLDER : 'openapi: 3.0.3\ninfo: { title: Market data }\nservers: [{ url: https://api.example.com/v1 }]\npaths: …'}
              spellCheck={false}
              className="mt-1 min-h-64 font-mono text-[12px]"
              invalid={Boolean(error)}
              autoFocus
            />
          </>
        )}
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">{t(kind === 'yaml' ? 'connector.yamlHint' : 'connector.openapiHint')}</p>
        {kind !== 'yaml' && (
          <div className="mt-3">
            <label htmlFor="connector-slug" className="text-[11px] font-semibold text-ink-600">{t('connector.slugLabel')}</label>
            <Input id="connector-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="market-data" spellCheck={false} className="mt-1 max-w-xs" />
          </div>
        )}
        <div className="mt-3 border-t border-ink-100 pt-3">
          <Switch checked={adhocRead} onChange={setAdhocRead} label={t('connector.adhocLabel')} description={t('connector.adhocHint')} />
        </div>
        <div aria-live="polite">{error && <ErrorNote>{error}</ErrorNote>}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onDone}>{t('common.cancel')}</Button>
          <Button type="submit" tone="primary" disabled={saving || !text.trim()}>{saving ? t('connector.creating') : t('connector.next')}</Button>
        </div>
      </Section>
    </form>
  )
}

/** The three steps, as a strip at the top of the create form and a draft. */
function Progress({ step, connector }: { step: 1 | 2 | 3; connector?: ApiConnectorDetail }) {
  const t = useT()
  const steps: Array<{ label: MessageKey; done: boolean }> = [
    { label: 'connector.step.source', done: step > 1 },
    { label: 'connector.step.review', done: Boolean(connector && !needsReview(connector)) },
    { label: 'connector.step.credentials', done: Boolean(connector && connector.credentials.every((c) => c.updatedAt)) },
  ]
  return (
    <ol className="flex flex-wrap gap-2" aria-label={t('connector.progress')}>
      {steps.map((s, i) => {
        const current = i + 1 === step
        return (
          <li
            key={s.label}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11.5px] font-semibold',
              current ? 'border-skype bg-sky2-50 text-skype-deep' : s.done ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-ink-100 bg-cloud text-ink-500',
            )}
          >
            <span aria-hidden className="tabular-nums">{s.done ? '✓' : i + 1}</span>
            {t(s.label)}
            {s.done && <span className="sr-only">{t('connector.stepDone')}</span>}
          </li>
        )
      })}
    </ol>
  )
}

// ── step 2: read/write review ───────────────────────────────────────────

function ActionsSection({ connector }: { connector: ApiConnectorDetail }) {
  const t = useT()
  const setEffect = useConnectors((s) => s.setEffect)
  const confirmActions = useConnectors((s) => s.confirmActions)
  const saving = useConnectors((s) => s.saving)
  const unconfirmed = connector.actions.filter((a) => !a.effectConfirmed).length
  return (
    <Section
      title={t('connector.actions')}
      eyebrow={t('connector.actionCount', { n: connector.actions.length })}
      action={unconfirmed > 0
        ? <Button tone="primary" disabled={saving} onClick={() => void confirmActions(connector.id)}>{t('connector.confirmMarking')}</Button>
        : undefined}
    >
      <p className="text-[11.5px] leading-relaxed text-ink-500">{t('connector.reviewHint')}</p>
      <ul className="mt-2 divide-y divide-ink-100">
        {connector.actions.map((a) => <ActionRow key={a.id} connector={connector} action={a} disabled={saving} onChange={(e) => void setEffect(connector.id, a.id, e)} />)}
      </ul>
    </Section>
  )
}

function ActionRow({ connector, action, disabled, onChange }: {
  connector: ApiConnectorDetail; action: ApiConnectorAction; disabled: boolean; onChange: (effect: 'read' | 'write') => void
}) {
  const t = useT()
  const canRead = SAFE_METHODS.has(action.method ?? '')
  const hintId = `effect-hint-${connector.id}-${action.id}`
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-ink-900">{connector.slug}.{action.id}</span>
          {action.method && <span className="font-mono text-[10.5px] text-ink-400">{action.method}</span>}
          {!action.effectConfirmed && <Pill tone="warn">{t('connector.unconfirmed')}</Pill>}
        </div>
        {action.description && <div className="mt-0.5 text-[11px] text-ink-500">{action.description}</div>}
        {!canRead && <div id={hintId} className="mt-0.5 text-[10.5px] text-ink-400">{t('connector.writeOnlyHint', { method: action.method ?? '?' })}</div>}
      </div>
      <div role="radiogroup" aria-label={t('connector.effectLabel', { action: action.id })} className="flex shrink-0 overflow-hidden rounded-lg border border-ink-100">
        {(['read', 'write'] as const).map((effect) => {
          const on = action.effect === effect
          const blocked = effect === 'read' && !canRead
          return (
            <button
              key={effect}
              type="button"
              role="radio"
              aria-checked={on}
              aria-describedby={blocked ? hintId : undefined}
              disabled={disabled || blocked}
              title={blocked ? t('connector.writeOnlyHint', { method: action.method ?? '?' }) : undefined}
              onClick={() => { if (!on || !action.effectConfirmed) onChange(effect) }}
              className={cn(
                'min-h-[36px] min-w-[52px] px-3 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
                on ? (effect === 'read' ? 'bg-sky2-50 text-skype-deep' : 'bg-coral-soft/40 text-coral-deep') : 'bg-cloud text-ink-500 hover:bg-ink-50',
              )}
            >
              {t(effect === 'read' ? 'connector.effect.read' : 'connector.effect.write')}
            </button>
          )
        })}
      </div>
    </li>
  )
}

// ── step 3: credentials and a test call ─────────────────────────────────

/** Seal in the browser, relay through the server, store on the bot host.
 *  The value lives only in this component's state and is cleared at once. */
async function saveCredential(connector: ApiConnectorDetail, name: string, value: string): Promise<void> {
  const key = await api.getVaultKey()
  const sealed = await sealCredential(key.publicKey, { connector: connector.slug, name, value })
  await api.putConnectorCredential(connector.id, { name, computerId: key.computerId, sealed })
}

function hostError(t: ReturnType<typeof useT>, err: unknown, offline: MessageKey): string {
  if (err instanceof ApiError && err.status === 409) return t(offline)
  return err instanceof Error ? err.message : String(err)
}

function CredentialsSection({ connector }: { connector: ApiConnectorDetail }) {
  const t = useT()
  const refreshOne = useConnectors((s) => s.refreshOne)
  const secure = canSeal()
  return (
    <Section title={t('connector.credentials')} eyebrow={t('connector.credentialsEyebrow')}>
      <p className="text-[11.5px] leading-relaxed text-ink-500">{t('connector.credentialsHint')}</p>
      {!secure && <ErrorNote>{t('connector.credentialNeedsHttps')}</ErrorNote>}
      <ul className="mt-3 divide-y divide-ink-100">
        {connector.credentials.map((c) => (
          <CredentialRow key={c.name} connector={connector} name={c.name} updatedAt={c.updatedAt} disabled={!secure} onChanged={() => void refreshOne(connector.id)} />
        ))}
      </ul>
    </Section>
  )
}

function CredentialRow({ connector, name, updatedAt, disabled, onChanged }: {
  connector: ApiConnectorDetail; name: string; updatedAt: string | null; disabled: boolean; onChanged: () => void
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const inputId = `cred-${connector.id}-${name}`
  const run = async (work: () => Promise<void>, done: MessageKey) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await work()
      setNotice(done)
      onChanged()
    } catch (err) {
      setError(hostError(t, err, 'connector.credentialHostOffline'))
    } finally {
      setValue('')
      setBusy(false)
    }
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value || busy) return
    void run(() => saveCredential(connector, name, value), 'connector.credentialSaved')
  }
  const remove = () => {
    if (busy || !window.confirm(t('connector.credentialDeleteConfirm', { name }))) return
    void run(async () => { await api.deleteConnectorCredential(connector.id, name) }, 'connector.credentialDeleted')
  }
  return (
    <li className="py-3">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1">
          <label htmlFor={inputId} className="flex items-center gap-2 text-[12px] font-semibold text-ink-800">
            <span className="font-mono">{name}</span>
            <Pill tone={updatedAt ? 'good' : 'warn'}>{updatedAt ? t('connector.credentialSet') : t('connector.credentialMissing')}</Pill>
          </label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={updatedAt ? t('connector.credentialReplace') : t('connector.credentialPlaceholder')}
            disabled={disabled || busy}
            className="mt-1.5"
          />
          {updatedAt && <p className="mt-1 text-[10.5px] text-ink-400">{t('connector.credentialUpdated', { time: new Date(updatedAt).toLocaleString() })}</p>}
        </div>
        <Button type="submit" tone="primary" disabled={disabled || busy || !value}>{busy ? t('connector.credentialSaving') : t('connector.credentialSave')}</Button>
        {updatedAt && <Button tone="danger" disabled={busy} onClick={remove}>{t('connector.credentialDelete')}</Button>}
      </form>
      <div aria-live="polite">
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && <p className="mt-2 text-[11px] text-emerald-700">{t(notice)}</p>}
      </div>
    </li>
  )
}

function TestSection({ connector }: { connector: ApiConnectorDetail }) {
  const t = useT()
  const reads = connector.actions.filter((a) => a.effect === 'read' && SAFE_METHODS.has(a.method ?? ''))
  const [actionId, setActionId] = useState(reads[0]?.id ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApiConnectorTestResult | null>(null)
  const action = reads.find((a) => a.id === actionId) ?? reads[0]
  const params = Object.entries((action?.paramsSchema ?? {}) as Record<string, ParamSpec>)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!action || busy) return
    const args: Record<string, unknown> = {}
    for (const [name, spec] of params) {
      const raw = values[name]?.trim() ?? ''
      if (!raw) continue
      args[name] = spec.type === 'integer' || spec.type === 'number' ? Number(raw) : spec.type === 'boolean' ? raw === 'true' : raw
    }
    setBusy(true); setError(null); setResult(null)
    try {
      setResult((await api.testConnector(connector.id, { action: action.id, args })).result)
    } catch (err) {
      setError(hostError(t, err, 'connector.testHostOffline'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('connector.test')} eyebrow={t('connector.testEyebrow')}>
      {reads.length === 0 ? (
        <p className="text-[11.5px] text-ink-500">{t('connector.testNoReads')}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor={`test-action-${connector.id}`} className="text-[11px] font-semibold text-ink-600">{t('connector.testAction')}</label>
          <select
            id={`test-action-${connector.id}`}
            value={action?.id}
            onChange={(e) => { setActionId(e.target.value); setValues({}); setResult(null) }}
            className="mt-1 block min-h-[40px] w-full max-w-sm rounded-lg border border-ink-100 bg-cloud px-2 font-mono text-[12px] text-ink-900"
          >
            {reads.map((a) => <option key={a.id} value={a.id}>{connector.slug}.{a.id}</option>)}
          </select>
          {params.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {params.map(([name, spec]) => (
                <div key={name}>
                  <label htmlFor={`test-${connector.id}-${name}`} className="text-[11px] font-semibold text-ink-600">
                    <span className="font-mono">{name}</span> <span className="font-normal text-ink-400">{spec.type ?? 'string'}{spec.required ? '' : ` · ${t('connector.optional')}`}</span>
                  </label>
                  <Input
                    id={`test-${connector.id}-${name}`}
                    value={values[name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                    inputMode={spec.type === 'integer' || spec.type === 'number' ? 'decimal' : undefined}
                    placeholder={spec.type === 'boolean' ? 'true / false' : spec.description}
                    spellCheck={false}
                    className="mt-1"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button type="submit" tone="primary" disabled={busy}>{busy ? t('connector.testing') : t('connector.testRun')}</Button>
          </div>
        </form>
      )}
      <div aria-live="polite">
        {error && <ErrorNote>{error}</ErrorNote>}
        {result && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
              <Pill tone={result.status < 400 ? 'good' : 'bad'}>HTTP {result.status}</Pill>
              <span>{t('connector.testMeta', { ms: result.durationMs, bytes: result.bytes })}</span>
              {result.truncated && <span>{t('connector.testTruncated')}</span>}
            </div>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-800">{result.preview || t('connector.testEmpty')}</pre>
          </div>
        )}
      </div>
    </Section>
  )
}

// ── the detail page ─────────────────────────────────────────────────────

function ConnectorDetail({ connector }: { connector: ApiConnectorDetail }) {
  const t = useT()
  const update = useConnectors((s) => s.update)
  const saving = useConnectors((s) => s.saving)
  const error = useConnectors((s) => s.error)
  const warnings = useConnectors((s) => s.warnings)
  const status = STATUS[connector.status]
  const active = connector.status === 'active'
  const draft = connector.status === 'draft'
  const review = needsReview(connector)
  return (
    <div className="mx-auto max-w-[860px] px-4 py-5 md:px-7">
      {draft && <div className="mb-4"><Progress step={review ? 2 : 3} connector={connector} /></div>}
      <header className="rounded-2xl border border-ink-100 bg-cloud p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={status.tone}>{t(status.label)}</Pill>
              <Pill tone="blue">{connector.kind}</Pill>
              {connector.createdByKind === 'bot' && <Pill tone="warn">{t('connector.botDraft')}</Pill>}
            </div>
            <h2 className="mt-2 text-[20px] font-semibold tracking-tight text-ink-900">{connector.name ?? connector.slug}</h2>
            {connector.description && <p className="mt-1 text-[12px] text-ink-600">{connector.description}</p>}
            <p className="mt-1 break-all font-mono text-[11px] text-ink-400">{connector.baseUrl}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button
              tone={active ? 'default' : 'primary'}
              disabled={saving || (!active && review)}
              onClick={() => void update(connector.id, { status: active ? 'disabled' : 'active' })}
            >
              {active ? t('connector.disable') : t('connector.enable')}
            </Button>
            {!active && review && <span className="max-w-[220px] text-right text-[10.5px] text-ink-400">{t('connector.enableNeedsReview')}</span>}
          </div>
        </div>
        {draft && connector.createdByKind === 'bot' && (
          <p className="mt-3 rounded-xl bg-gold/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800">{t('connector.botDraftHint')}</p>
        )}
        {warnings.length > 0 && draft && (
          <details className="mt-3 rounded-xl bg-ink-50 px-3 py-2 text-[11px] text-ink-600">
            <summary className="cursor-pointer font-semibold">{t('connector.importWarnings', { n: warnings.length })}</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </details>
        )}
        <div aria-live="polite">{error && <ErrorNote>{error}</ErrorNote>}</div>
        <div className="mt-4 border-t border-ink-100 pt-3">
          <Switch
            checked={connector.adhocRead}
            disabled={saving}
            onChange={(next) => void update(connector.id, { adhocRead: next })}
            label={t('connector.adhocLabel')}
            description={t('connector.adhocHint')}
          />
        </div>
      </header>

      <ActionsSection connector={connector} />
      {connector.credentials.length > 0 && <CredentialsSection connector={connector} />}
      <TestSection key={connector.id} connector={connector} />

      <Section title={t('connector.definition')}>
        <pre className="max-h-96 overflow-auto rounded-xl bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-800">{connector.definitionYaml}</pre>
      </Section>
    </div>
  )
}
