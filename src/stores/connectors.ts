import { create } from 'zustand'
import { type ApiConnector, type ApiConnectorDetail, type ApiConnectorSource, type ApiConnectorStatus, api, ws } from '@/api/client'
import { isForActiveWorkspace } from '@/lib/tenant-events'
import { commitIfContextCurrent, getActiveCompanyId } from './auth'

/** Personal-mode connectors for the console (docs/personal-bot/mvp-frontend-design.md §5.2). */
interface ConnectorsState {
  connectors: ApiConnector[]
  loaded: boolean
  loading: boolean
  selectedId: string | null
  details: Record<string, ApiConnectorDetail>
  saving: boolean
  error: string | null
  load: (force?: boolean) => Promise<void>
  select: (id: string | null) => Promise<void>
  /** Warnings from an OpenAPI import (operations skipped or simplified). */
  warnings: string[]
  create: (input: ApiConnectorSource & { adhocRead: boolean }) => Promise<ApiConnectorDetail | null>
  update: (id: string, input: { status?: ApiConnectorStatus; adhocRead?: boolean }) => Promise<void>
  setEffect: (id: string, actionId: string, effect: 'read' | 'write') => Promise<void>
  confirmActions: (id: string) => Promise<void>
  /** Run one change that answers with the updated connector. */
  mutate: (id: string, run: () => Promise<{ connector: ApiConnectorDetail }>) => Promise<void>
  /** Patch one row after `connector.changed`. */
  refreshOne: (id: string) => Promise<void>
  reset: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summary(detail: ApiConnectorDetail): ApiConnector {
  const { definitionYaml: _yaml, ...rest } = detail
  return rest
}

function upsert(list: ApiConnector[], row: ApiConnector): ApiConnector[] {
  const i = list.findIndex((c) => c.id === row.id)
  if (i < 0) return [...list, row]
  const next = list.slice()
  next[i] = row
  return next
}

const INITIAL = {
  connectors: [] as ApiConnector[],
  loaded: false,
  loading: false,
  selectedId: null as string | null,
  details: {} as Record<string, ApiConnectorDetail>,
  saving: false,
  error: null as string | null,
  warnings: [] as string[],
}

export const useConnectors = create<ConnectorsState>((set, get) => ({
  ...INITIAL,

  load: async (force = false) => {
    if (get().loading || (get().loaded && !force)) return
    set({ loading: true, error: null })
    try {
      await commitIfContextCurrent(() => api.listConnectors(), ({ connectors }) => {
        const selectedId = get().selectedId && connectors.some((c) => c.id === get().selectedId)
          ? get().selectedId
          : connectors[0]?.id ?? null
        set({ connectors, loaded: true, selectedId })
        if (selectedId) void get().select(selectedId)
      })
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ loading: false })
    }
  },

  select: async (id) => {
    set({ selectedId: id })
    if (!id || get().details[id]) return
    try {
      await commitIfContextCurrent(() => api.getConnector(id), ({ connector }) => {
        set((s) => ({ details: { ...s.details, [id]: connector } }))
      })
    } catch (error) {
      set({ error: message(error) })
    }
  },

  create: async (input) => {
    set({ saving: true, error: null, warnings: [] })
    try {
      const { connector, warnings } = await api.createConnector({ ...input, requestId: crypto.randomUUID() })
      set((s) => ({
        connectors: upsert(s.connectors, summary(connector)),
        details: { ...s.details, [connector.id]: connector },
        selectedId: connector.id,
        warnings: warnings ?? [],
      }))
      return connector
    } catch (error) {
      set({ error: message(error) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  update: (id, input) => get().mutate(id, () => api.updateConnector(id, input)),
  setEffect: (id, actionId, effect) => get().mutate(id, () => api.setConnectorActionEffect(id, actionId, effect)),
  confirmActions: (id) => get().mutate(id, () => api.confirmConnectorActions(id)),

  mutate: async (id, run) => {
    set({ saving: true, error: null })
    try {
      const { connector } = await run()
      set((s) => ({ connectors: upsert(s.connectors, summary(connector)), details: { ...s.details, [id]: connector } }))
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ saving: false })
    }
  },

  refreshOne: async (id) => {
    try {
      await commitIfContextCurrent(() => api.getConnector(id), ({ connector }) => {
        set((s) => ({ connectors: upsert(s.connectors, summary(connector)), details: { ...s.details, [id]: connector } }))
      })
    } catch { /* a later load() reconciles */ }
  },

  reset: () => set({ ...INITIAL }),
}))

// Created or changed elsewhere (another device, a bot draft): refetch that
// one row, but only once the console has loaded the list.
ws.on((ev) => {
  if (ev.type !== 'connector.changed') return
  if (!isForActiveWorkspace(ev.companyId, getActiveCompanyId())) return
  if (!useConnectors.getState().loaded) return
  void useConnectors.getState().refreshOne(ev.connectorId)
})
