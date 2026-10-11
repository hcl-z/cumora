/**
 * Connectors tab (docs/personal-bot/mvp-frontend-design.md §3.2), T08 scope:
 * the list, a read-only detail, creation from pasted YAML, and the two
 * switches the minimal flow needs — enable, and "临时任务可读" (ad-hoc tasks
 * may use its read actions). The guided wizard and per-action read/write
 * confirmation come with T10; credentials with T09.
 */
import { useEffect, useState } from 'react'
import { type ApiConnector, type ApiConnectorDetail, type ApiConnectorStatus, ApiError, api } from '@/api/client'
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

const YAML_PLACEHOLDER = `id: market-data
name: Market data
base_url: https://api.example.com/v1
actions:
  - id: quote
    effect: read
    method: GET
    path: /quote/{symbol}
    params: { symbol: string }`

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
    </button>
  )
}

function CreateConnector({ onDone }: { onDone: () => void }) {
  const t = useT()
  const create = useConnectors((s) => s.create)
  const saving = useConnectors((s) => s.saving)
  const error = useConnectors((s) => s.error)
  const [yaml, setYaml] = useState('')
  const [adhocRead, setAdhocRead] = useState(true)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!yaml.trim()) return
    if (await create({ yaml, adhocRead })) onDone()
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-[860px] px-4 py-5 md:px-7">
      <Section title={t('connector.newTitle')} eyebrow={t('connector.newEyebrow')}>
        <label htmlFor="connector-yaml" className="text-[11px] font-semibold text-ink-600">{t('connector.yamlLabel')}</label>
        <TextArea
          id="connector-yaml"
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          placeholder={YAML_PLACEHOLDER}
          spellCheck={false}
          className="mt-1 min-h-64 font-mono text-[12px]"
          invalid={Boolean(error)}
          autoFocus
        />
        <p className="mt-1.5 text-[11px] text-ink-400">{t('connector.yamlHint')}</p>
        <div className="mt-3 border-t border-ink-100 pt-3">
          <Switch checked={adhocRead} onChange={setAdhocRead} label={t('connector.adhocLabel')} description={t('connector.adhocHint')} />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onDone}>{t('common.cancel')}</Button>
          <Button type="submit" tone="primary" disabled={saving || !yaml.trim()}>{t('connector.create')}</Button>
        </div>
      </Section>
    </form>
  )
}

/** Seal in the browser, relay through the server, store on the bot host.
 *  The value lives only in this component's state and is cleared at once. */
async function saveCredential(connector: ApiConnectorDetail, name: string, value: string): Promise<void> {
  const key = await api.getVaultKey()
  const sealed = await sealCredential(key.publicKey, { connector: connector.slug, name, value })
  await api.putConnectorCredential(connector.id, { name, computerId: key.computerId, sealed })
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
          <CredentialRow key={c.name} connector={connector} name={c.name} updatedAt={c.updatedAt} disabled={!secure} onSaved={() => void refreshOne(connector.id)} />
        ))}
      </ul>
    </Section>
  )
}

function CredentialRow({ connector, name, updatedAt, disabled, onSaved }: {
  connector: ApiConnectorDetail; name: string; updatedAt: string | null; disabled: boolean; onSaved: () => void
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inputId = `cred-${connector.id}-${name}`
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value || busy) return
    setBusy(true); setError(null); setSaved(false)
    try {
      await saveCredential(connector, name, value)
      setValue('')
      setSaved(true)
      onSaved()
    } catch (err) {
      setValue('')
      setError(err instanceof ApiError && err.status === 409 ? t('connector.credentialHostOffline') : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="py-3">
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
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
      </form>
      <div aria-live="polite">
        {error && <ErrorNote>{error}</ErrorNote>}
        {saved && <p className="mt-2 text-[11px] text-emerald-700">{t('connector.credentialSaved')}</p>}
      </div>
    </li>
  )
}

function ConnectorDetail({ connector }: { connector: ApiConnectorDetail }) {
  const t = useT()
  const update = useConnectors((s) => s.update)
  const saving = useConnectors((s) => s.saving)
  const error = useConnectors((s) => s.error)
  const status = STATUS[connector.status]
  const active = connector.status === 'active'
  return (
    <div className="mx-auto max-w-[860px] px-4 py-5 md:px-7">
      <header className="rounded-2xl border border-ink-100 bg-cloud p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={status.tone}>{t(status.label)}</Pill>
              <Pill tone="blue">{connector.kind}</Pill>
            </div>
            <h2 className="mt-2 text-[20px] font-semibold tracking-tight text-ink-900">{connector.name ?? connector.slug}</h2>
            {connector.description && <p className="mt-1 text-[12px] text-ink-600">{connector.description}</p>}
            <p className="mt-1 break-all font-mono text-[11px] text-ink-400">{connector.baseUrl}</p>
          </div>
          <Button tone={active ? 'default' : 'primary'} disabled={saving} onClick={() => void update(connector.id, { status: active ? 'disabled' : 'active' })}>
            {active ? t('connector.disable') : t('connector.enable')}
          </Button>
        </div>
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

      <Section title={t('connector.actions')} eyebrow={t('connector.actionCount', { n: connector.actions.length })}>
        <ul className="divide-y divide-ink-100">
          {connector.actions.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-2.5">
              <Pill tone={a.effect === 'read' ? 'blue' : 'warn'}>{t(a.effect === 'read' ? 'connector.effect.read' : 'connector.effect.write')}</Pill>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12px] text-ink-900">{connector.slug}.{a.id}</div>
                {a.description && <div className="mt-0.5 text-[11px] text-ink-500">{a.description}</div>}
              </div>
              {a.method && <span className="font-mono text-[10.5px] text-ink-400">{a.method}</span>}
            </li>
          ))}
        </ul>
      </Section>

      {connector.credentials.length > 0 && <CredentialsSection connector={connector} />}

      <Section title={t('connector.definition')}>
        <pre className="max-h-96 overflow-auto rounded-xl bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-800">{connector.definitionYaml}</pre>
      </Section>
    </div>
  )
}
