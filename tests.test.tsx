import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = 1_700_000_000_000
const ROOT = '/repo'
const DIR = `${ROOT}/.claude/collision-guard`
const FILE = `${ROOT}/src/app.ts`

type Asked = { text: string }

/** The world beneath the plugin: identity, a surface, and a stub Edit tool. */
const world = (on: On, peerEditedAt: number | null) => {
  const asked: Asked[] = []
  let wrote = 0

  mock.clock(on, { now: NOW })

  on('session.id', () => ({ value: 'aaaaaaaa-1111-2222-3333-444444444444' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))

  on('fs.write', () => {
    wrote += 1

    return { value: undefined }
  })

  on('fs.list', ($, e) => ({
    value:
      e.path === DIR && peerEditedAt !== null
        ? [{ name: 'bbbb.json', kind: 'file' as const, size: 10, mtimeMs: NOW, isLink: false }]
        : [],
  }))

  on('fs.read', () => ({
    value: JSON.stringify({
      sessionId: 'bbbbbbbb',
      label: 'session bbbbbbbb',
      startedAt: NOW - 600_000,
      heartbeatAt: NOW - 5_000,
      activity: 'refactoring the parser',
      status: 'in progress',
      edits: peerEditedAt === null ? {} : { [FILE]: peerEditedAt },
    }),
  }))

  // The dialog: record the question, then report it as dismissed.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked.push({ text: JSON.stringify(e) })

    return { deny: 'dismissed' }
  })

  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))

  // The edit tools themselves.
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  on('tool.call', { tool: 'NotebookEdit' }, () => ({ result: { ok: true } }))

  return { asked, wrote: () => wrote }
}

test('an edit no other session touched runs, and is not questioned', async ($, on) => {
  const { asked } = world(on, null)

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'a',
    new_string: 'b',
  })

  expect(ran.deny).toBeUndefined()
  expect(asked).toHaveLength(0)
})

test('an edit another live session made 5 minutes ago is questioned', async ($, on) => {
  const { asked } = world(on, NOW - 5 * 60 * 1000)

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'a',
    new_string: 'b',
  })

  // It asked, naming the file, the other session and how long ago.
  expect(asked).toHaveLength(1)
  expect(asked[0]?.text).toContain('app.ts')
  expect(asked[0]?.text).toContain('session bbbbbbbb')
  expect(asked[0]?.text).toContain('5 minutes ago')
  expect(asked[0]?.text).toContain('refactoring the parser')

  // Dismissed with someone there: the edit is held, and the model is told why.
  expect(typeof ran.deny).toBe('string')
  expect(ran.deny).toContain('session bbbbbbbb')
})

test('an edit another session made 2 hours ago is outside the window', async ($, on) => {
  const { asked } = world(on, NOW - 120 * 60 * 1000)

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'a',
    new_string: 'b',
  })

  expect(ran.deny).toBeUndefined()
  expect(asked).toHaveLength(0)
})

test('the band names the other session and what it is doing', async ($, on) => {
  world(on, NOW - 5 * 60 * 1000)

  // A prompt refreshes the peer list the band reads.
  await $.prompt.submit({ text: 'add a test' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'collision-guard',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 12,
        bodyColumns: 75,
        scroll: { bodyRows: 12, offset: 0, isAtTop: true, isAtBottom: true },
        view: { columns: 80, rows: 24 },
      },
      viewport: { columns: 80, rows: 24 },
    })

    const line = await ui.find({ type: 'Text', text: /refactoring the parser/ })
    expect(line).toBeDefined()
    expect(line?.text).toContain('in progress')
    await ui.unmount()
  }
})

test('a notebook another live session just edited is questioned too', async ($, on) => {
  const { asked } = world(on, NOW - 5 * 60 * 1000)

  const ran = await $.tool.call({
    tool: 'NotebookEdit',
    notebook_path: FILE,
    new_source: 'print(1)',
  })

  expect(asked).toHaveLength(1)
  expect(asked[0]?.text).toContain('app.ts')
  expect(typeof ran.deny).toBe('string')
})
