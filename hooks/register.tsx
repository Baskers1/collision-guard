import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Peer, PeerStatus } from '../types'

const NAME = 'collision-guard'

/** How far back a peer's edit still counts as a collision. */
const WINDOW_MS = 30 * 60 * 1000
/** A session whose ledger is older than this is treated as gone. */
const LIVE_MS = 90 * 1000
/** How often this session rewrites its ledger and re-reads the others. */
const BEAT_MS = 15 * 1000
/** Most recent edits kept per session. */
const MAX_EDITS = 200


const peers = atom({ plugin: 'collision-guard', key: 'peers' } as const, [])
const isHidden = atom({ plugin: 'collision-guard', key: 'isHidden' } as const, false)

type Ledger = {
  sessionId: string
  label: string
  startedAt: number
  heartbeatAt: number
  activity: string
  status: PeerStatus
  /** Absolute file path -> when this session last wrote it, epoch ms. */
  edits: Record<string, number>
}

let me: Ledger | undefined
let dir = ''
let cwd = ''
let mine = ''
let seen = new Set<string>()

const ago = (ms: number) => {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes === 1) return '1 minute ago'
  return `${minutes} minutes ago`
}

const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const absolute = (path: string) =>
  path.startsWith('/') || /^[A-Za-z]:/.test(path)
    ? path
    : `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`

/** Reads this session's identity once, and lays down its ledger file. */
const start = async ($: EngineInterface): Promise<Ledger> => {
  if (me !== undefined) return me

  const [sessionId, root, at] = await Promise.all([
    $.session.id(),
    $.session.root(),
    $.clock.now(),
  ])
  cwd = await $.session.cwd().catch(() => root)
  dir = `${root.replace(/\/$/, '')}/.claude/${NAME}`
  mine = `${dir}/${sessionId}.json`
  me = {
    sessionId,
    label: `session ${sessionId.slice(0, 8)}`,
    startedAt: at,
    heartbeatAt: at,
    activity: 'just opened, nothing asked yet',
    status: 'done',
    edits: {},
  }
  await save($)

  return me
}

/** Writes this session's ledger. One file per session, so sessions never race. */
const save = async ($: EngineInterface) => {
  if (me === undefined) return
  me.heartbeatAt = await $.clock.now()

  const kept = Object.entries(me.edits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EDITS)
  me.edits = Object.fromEntries(kept)

  await $.fs.write(mine, JSON.stringify(me)).catch(() => {})
}

/** Every other session's ledger that is still beating. */
const others = async ($: EngineInterface): Promise<Ledger[]> => {
  const at = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const found: Ledger[] = []

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (`${dir}/${entry.name}` === mine) continue

    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    if (text === undefined) continue

    try {
      const one = JSON.parse(text) as Ledger
      if (typeof one?.sessionId !== 'string') continue
      if (at - (one.heartbeatAt ?? 0) > LIVE_MS) continue
      found.push(one)
    } catch {
      continue
    }
  }

  return found
}

/** Re-reads the other sessions' ledgers and refreshes the band. */
const refresh = async ($: EngineInterface) => {
  const live = await others($)

  const next: Peer[] = live.map(one => ({
    sessionId: one.sessionId,
    label: one.label,
    activity: one.activity,
    status: one.status,
    heartbeatAt: one.heartbeatAt,
  }))

  for (const one of next) {
    if (seen.has(one.sessionId)) continue
    seen.add(one.sessionId)
    $.ui.toast(`Another session is open here: ${one.activity}`)
  }
  seen = new Set(next.map(one => one.sessionId))

  await update($, peers, () => next)
}

/** Rewrites this session's ledger, then refreshes the band. */
const beat = async ($: EngineInterface) => {
  await save($)
  await refresh($)
}

const HELD = {
  deny: `${NAME}: its collision check failed, so the edit was held.`,
}

/**
 * The call's target path. This build does not narrow a tool.call union by its
 * matcher, so the field is read by name rather than off a narrowed `e`.
 */
function pathOf(e: unknown, key: 'file_path' | 'notebook_path'): string {
  const value = (e as Record<string, unknown> | null)?.[key]

  return typeof value === 'string' ? value : ''
}

/** Holds an edit when another live session wrote that same file recently. */
async function guard<E>(
  $: EngineInterface,
  e: E,
  named: string,
  next: (e: E) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
    if (named === '') return next(e)

  const ledger = await start($)
  const path = absolute(named)
    const at = await $.clock.now()

    const live = await others($)
    const clash = live
      .map(one => ({ one, when: one.edits?.[path] ?? 0 }))
      .filter(found => at - found.when <= WINDOW_MS && found.when > 0)
      .sort((a, b) => b.when - a.when)[0]

    if (clash === undefined) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        ledger.edits[path] = await $.clock.now()
        await save($)
      }

      return ran
    }

    const question =
      `${name(path)} was changed by ${clash.one.label} ${ago(at - clash.when)}` +
      ` (working on: ${clash.one.activity}). What should I do?`

    const answer = await $.ui
      .ask(question, {
        options: ['Proceed', 'Move to a worktree', 'Cancel'],
        header: 'Collision',
      })
      .catch(async () => {
        // Nobody could answer. Unattended (a -p run draws on no surface): go
        // on, and leave a line. Dismissed with someone there: hold it.
        const drawn = await $.session.surfaces().catch(() => [])
        if (drawn.length === 0) {
          $.ui.log(
            `${NAME}: ${name(path)} was changed by ${clash.one.label}` +
              ` ${ago(at - clash.when)}; nobody to ask, so the edit went ahead.`,
          )

          return 'Proceed'
        }

        return 'Cancel'
      })

    if (answer === 'Cancel') {
      return {
        deny:
          `${NAME}: the user cancelled this edit. ${name(path)} was changed by` +
          ` ${clash.one.label} ${ago(at - clash.when)}. Do not retry it; ask what to do instead.`,
      }
    }

    if (answer === 'Move to a worktree') {
      return {
        deny:
          `${NAME}: the user wants this work moved to a git worktree first, because` +
          ` ${clash.one.label} is editing ${name(path)}. Do not edit this file here.` +
          ` Create a worktree (git worktree add), move there, and make the change in it.`,
      }
    }

    if (answer !== 'Proceed') {
      return {
        deny:
          `${NAME}: the edit to ${name(path)} was held because ${clash.one.label}` +
          ` changed it ${ago(at - clash.when)}. The user answered: "${answer}".` +
          ` Follow that instruction instead of repeating this edit.`,
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      ledger.edits[path] = await $.clock.now()
      await save($)
    }

    return ran
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await start($)
    void beat($)
    $.clock.every(BEAT_MS, () => void beat($).catch(() => {}))

    return next(e)
  }).catch(($, e, next) => next(e))

  // What this session is working on, for the other sessions' bands.
  on('prompt.submit', async ($, e, next) => {
    const ledger = await start($)
    const text = e.text.trim().replace(/\s+/g, ' ')
    ledger.activity = text.length > 70 ? `${text.slice(0, 70)}…` : text
    ledger.status = 'in progress'
    await save($)
    await refresh($)

    return next(e)
    // Bookkeeping must never swallow the prompt.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && me !== undefined) {
      me.status = 'done'
      await save($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Edit', 'Write'] }, ($, e, next) =>
    guard($, e, pathOf(e, 'file_path'), next),
  ).catch(($, e, next) => (next.called ? next(e) : HELD))

  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) =>
    guard($, e, pathOf(e, 'notebook_path'), next),
  ).catch(($, e, next) => (next.called ? next(e) : HELD))

  // Part 2: the band, in every session, naming the others and their state.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, peers)
    if (list.length === 0 || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {list.map(one => (
          <Text dimColor>
            {one.status === 'in progress' ? '◌' : '✓'} {one.label}:{' '}
            {one.activity} ({one.status})
          </Text>
        ))}
        <Button
          key="hide"
          label="Hide"
          onPress={() => update($, isHidden, () => true)}
        />
      </Box>
    )
  })
}
