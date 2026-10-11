/**
 * The personal console shell (task T08). There is no React harness in this
 * repo, so the wiring is checked at the source: the Rail entry is gated on
 * personal mode, every console key exists in both locales, the switch is an
 * accessible role="switch", and the connectors store resets with the
 * workspace.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { en } from '../src/locales/en'
import { zhCN } from '../src/locales/zh-CN'

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('the console appears in the Rail only in personal mode', () => {
  const rail = src('desktop/Rail.tsx')
  assert.match(rail, /serverCapabilities\?\.personalMode === true/)
  assert.match(rail, /personalMode\s*\?\s*\[[^\]]*key: 'console'/s)
  assert.match(src('mobile/MobileMe.tsx'), /\{personalMode && \(\s*<Section title=\{t\('nav\.console'\)\}/)
})

test('both shells render the console lazily for view === "console"', () => {
  assert.match(src('desktop/DesktopApp.tsx'), /\{view === 'console' && <Suspense fallback=\{.*?\}><ConsoleView \/><\/Suspense>\}/)
  assert.match(src('mobile/MobileApp.tsx'), /view === 'console' && \([\s\S]*?<ConsoleWorkspace compact \/>/)
  assert.match(src('types.ts'), /\| 'console'/)
})

test('every console and connector string exists in both locales', () => {
  const keys = Object.keys(en).filter((k) => /^(console\.|connector\.|nav\.console$|mobileMe\.connectorsSub$)/.test(k))
  assert.ok(keys.length > 20)
  const missing = keys.filter((k) => !(k in zhCN))
  assert.deepEqual(missing, [])
  // Every key the console components reference is defined.
  const used = new Set<string>()
  for (const file of ['components/console/ConsoleWorkspace.tsx', 'components/console/ConnectorsTab.tsx']) {
    for (const m of src(file).matchAll(/'((?:console|connector|nav|mobileMe|common)\.[A-Za-z.]+)'/g)) used.add(m[1])
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), [])
})

test('the console switch is an accessible role="switch" button', () => {
  const ui = src('components/console/ui.tsx')
  assert.match(ui, /type="button"\s+role="switch"\s+aria-checked=\{checked\}/)
  assert.match(ui, /role="alert"/)
})

test('the connectors store resets on workspace switch and follows connector.changed', () => {
  assert.match(src('stores/auth.ts'), /import\('\.\/connectors'\)\.then\(\(\{ useConnectors \}\) => useConnectors\.getState\(\)\.reset\(\)\)/)
  const store = src('stores/connectors.ts')
  assert.match(store, /ev\.type !== 'connector\.changed'/)
  assert.match(store, /isForActiveWorkspace\(ev\.companyId, getActiveCompanyId\(\)\)/)
})
