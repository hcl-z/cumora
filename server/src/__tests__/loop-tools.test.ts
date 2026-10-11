/**
 * The `loop` engine has no OS sandbox: its file tools ARE the boundary, so
 * every escape route out of the agent home is pinned here, along with the
 * argv-only Cumora bridge rules it shares with the MCP shim.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { CUMORA_TOOL_NAME, MAX_TOOL_OUTPUT_BYTES, resolveInHome, runTool, truncateOutput, type RuntimeCliInvoker } from '../agents/computer/loop/tools.js'

let root: string
let home: string
let outside: string
const signal = new AbortController().signal

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'loop-tools-')))
  home = join(root, 'home')
  outside = join(root, 'outside')
  await mkdir(join(home, 'notes'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'operator secret')
  await writeFile(join(home, 'notes', 'a.md'), 'hello')
  await symlink(outside, join(home, 'escape'))
  await symlink(join(outside, 'secret.txt'), join(home, 'secret-link'))
})
after(async () => { await rm(root, { recursive: true, force: true }) })

const ctx = (runtimeCli: RuntimeCliInvoker | null = null) => ({ home, runtimeCli, signal })

test('paths inside the home resolve; relative paths are anchored at the home', async () => {
  assert.equal(await resolveInHome(home, 'notes/a.md'), join(home, 'notes', 'a.md'))
  assert.equal(await resolveInHome(home, join(home, 'notes', 'a.md')), join(home, 'notes', 'a.md'))
  assert.equal(await resolveInHome(home, 'notes/new/deep.md'), join(home, 'notes', 'new', 'deep.md'))
})

test('every way out of the home is refused', async () => {
  for (const raw of ['../outside/secret.txt', join(outside, 'secret.txt'), '/etc/hosts', 'notes/../../outside', '', 'a\0b']) {
    assert.equal(await resolveInHome(home, raw), null, raw)
  }
  // Through a symlink that points outside, for reads and for writes alike.
  assert.equal(await resolveInHome(home, 'escape/secret.txt'), null)
  assert.equal(await resolveInHome(home, 'escape/new.txt'), null)
  assert.equal(await resolveInHome(home, 'secret-link'), null)
})

test('the file tools read, write and edit only inside the home', async () => {
  assert.equal((await runTool('read_file', JSON.stringify({ path: 'notes/a.md' }), ctx())).output, 'hello')
  await runTool('write_file', JSON.stringify({ path: 'notes/b.md', content: 'one two' }), ctx())
  assert.equal(await readFile(join(home, 'notes', 'b.md'), 'utf8'), 'one two')
  await runTool('edit_file', JSON.stringify({ path: 'notes/b.md', old_string: 'two', new_string: '2' }), ctx())
  assert.equal(await readFile(join(home, 'notes', 'b.md'), 'utf8'), 'one 2')

  const read = await runTool('read_file', JSON.stringify({ path: 'escape/secret.txt' }), ctx())
  assert.match(read.output, /outside your home/)
  const write = await runTool('write_file', JSON.stringify({ path: '../outside/planted.txt', content: 'x' }), ctx())
  assert.match(write.output, /outside your home/)
  await assert.rejects(readFile(join(outside, 'planted.txt')))
})

test('edit_file refuses an ambiguous or missing match', async () => {
  await writeFile(join(home, 'notes', 'c.md'), 'x x')
  assert.match((await runTool('edit_file', JSON.stringify({ path: 'notes/c.md', old_string: 'x', new_string: 'y' }), ctx())).output, /more than once/)
  assert.match((await runTool('edit_file', JSON.stringify({ path: 'notes/c.md', old_string: 'z', new_string: 'y' }), ctx())).output, /not found/)
})

test('the Cumora tool forwards argv and reports a non-zero exit (HELD) to the model', async () => {
  const seen: string[][] = []
  const cli: RuntimeCliInvoker = async (argv) => {
    seen.push(argv)
    return argv[0] === 'reply' ? { text: 'HELD — newer messages', exitCode: 2 } : { text: 'ok', exitCode: 0 }
  }
  const held = await runTool(CUMORA_TOOL_NAME, JSON.stringify({ argv: ['reply', 'c1', 'hi `there` $HOME'] }), ctx(cli))
  assert.deepEqual(seen[0], ['reply', 'c1', 'hi `there` $HOME'])
  assert.match(held.output, /^exit 2\nHELD/)
  assert.equal((await runTool(CUMORA_TOOL_NAME, JSON.stringify({ argv: ['whoami'] }), ctx(cli))).output, 'ok')
})

test('the Cumora tool refuses local file flags and malformed argv, as the MCP shim does', async () => {
  const cli: RuntimeCliInvoker = async () => { throw new Error('must not be called') }
  assert.match((await runTool(CUMORA_TOOL_NAME, JSON.stringify({ argv: ['reply', 'c1', '--file', 'x.md'] }), ctx(cli))).output, /file\/stdin flags are unavailable/)
  assert.match((await runTool(CUMORA_TOOL_NAME, JSON.stringify({ argv: [] }), ctx(cli))).output, /invalid Cumora argv/)
  assert.match((await runTool(CUMORA_TOOL_NAME, JSON.stringify({ argv: [1] }), ctx(cli))).output, /invalid Cumora argv/)
  assert.match((await runTool(CUMORA_TOOL_NAME, '{not json', ctx(cli))).output, /not valid JSON/)
})

test('set_turn_status records only the five known states', async () => {
  const done = await runTool('set_turn_status', JSON.stringify({ status: 'done', reason: 'r', next_step: '' }), ctx())
  assert.equal(done.turnStatus?.status, 'done')
  const bad = await runTool('set_turn_status', JSON.stringify({ status: 'finished', reason: 'r', next_step: '' }), ctx())
  assert.equal(bad.turnStatus, undefined)
})

test('oversized output is cut at the cap without splitting a character', () => {
  const big = '中'.repeat(MAX_TOOL_OUTPUT_BYTES)
  const cut = truncateOutput(big)
  assert.ok(Buffer.byteLength(cut) < Buffer.byteLength(big))
  assert.ok(!cut.includes('\uFFFD'))
  assert.match(cut, /truncated/)
  assert.equal(truncateOutput('short'), 'short')
})
