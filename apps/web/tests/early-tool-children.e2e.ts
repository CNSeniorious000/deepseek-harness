/** Recorded PTC children arriving while their parent arguments are still streaming. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { deriveReplayScript } from '@deepseek-ai/dsh-llm-replay'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, readPersistedEvents, realizeSeedFixture, selectedSessionFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/early-tool-children', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/ptc-round/session.v4.jsonl', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: recorded children before their parent', () => {
  it.each(['complete', 'stop'] as const)('retains child inspection and history when the stream will %s', async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-early-tool-children-'))
    const release = Promise.withResolvers<undefined>()
    const continuation = Promise.withResolvers<undefined>()
    const approvalAbort = new AbortController()
    const ready = Promise.withResolvers<Session>()
    const owned: { scaffold?: WebScaffold; browser?: Browser; dispose?: () => void; approval?: Promise<ApprovalOutcome> } = {}
    onTestFinished(async () => {
      const failures: unknown[] = []
      approvalAbort.abort()
      await owned.approval?.catch((error: unknown) => failures.push(error))
      release.resolve(undefined)
      continuation.resolve(undefined)
      owned.dispose?.()
      await owned.browser?.close().catch((error: unknown) => failures.push(error))
      await owned.scaffold?.close().catch((error: unknown) => failures.push(error))
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      if (failures.length > 0) throw new AggregateError(failures, 'early-tool-children cleanup failed')
    })
    const fixture = await readFile(await selectedSessionFixture(FIXTURE), 'utf8')
    const script = deriveReplayScript(parseSeedFixture(fixture).events)
    const replayOverride = join(directory, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(outcome === 'stop' ? script.slice(0, 1) : script))
    const scaffold = owned.scaffold = await launchWebScaffold({
      agentPresets: { default: 'ptc' }, replayFixture: FIXTURE, replayOverride, compareReplaySession: false,
    })
    const events = parseSeedFixture(realizeSeedFixture(scaffold, fixture, 'early-tool-children-source')).events
    const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
    const [firstStart, secondStart] = starts
    const completed = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === firstStart?.data.subCallId)
    const failed = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === secondStart?.data.subCallId)
    if (firstStart === undefined || secondStart === undefined || completed?.type !== 'tool/ptc-dispatch'
      || failed?.type !== 'tool/ptc-dispatch') {
      throw new Error('PTC recording requires a completed child and a second started child')
    }
    const first = { ...firstStart.data, subCallId: ToolCallId(`${firstStart.data.subCallId}:early`) }
    const second = { ...secondStart.data, subCallId: ToolCallId(`${secondStart.data.subCallId}:early`) }
    let active: Session | undefined
    scaffold.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') active = session
    })
    let held = false
    // Deliver recorded child facts before the parent call, with separate ids from its later native dispatches.
    owned.dispose = scaffold.ctx.on('llm/stream', async function* (options, next) {
      // Keep the approval audit pair inside its turn while the parent has already arrived.
      if (held) await continuation.promise
      for await (const chunk of next()) {
        if (held || chunk.type !== 'tool-call-delta' || chunk.id !== first.rootCallId) {
          yield chunk
          continue
        }
        held = true
        if (active === undefined) throw new Error('stream has no active Session')
        active.append('tool/ptc-dispatch-start', first)
        active.append('tool/ptc-dispatch', { ...completed.data, subCallId: first.subCallId })
        active.append('tool/ptc-dispatch-start', second)
        ready.resolve(active)
        const abort = Promise.withResolvers<undefined>()
        const onAbort = () => { abort.resolve(undefined) }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          if (!options.signal?.aborted) await Promise.race([release.promise, abort.promise])
        } finally {
          options.signal?.removeEventListener('abort', onAbort)
        }
        if (options.signal?.aborted) return
        yield chunk
      }
    }, { prepend: true })
    const browser = owned.browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-early-tool-children-${outcome}`))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const [prompt] = fixtureUserPrompts(fixture)
    if (prompt === undefined) throw new Error('PTC recording has no user prompt')
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')
    const session = await ready.promise
    expect(session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
    const child = page.locator(`[data-chat-call-id="${first.subCallId}"]`)
    await expandOwningTurnProcess(page, child)
    await child.waitFor({ state: 'visible' })
    await child.locator('[data-sample="bash"]').click()
    await child.getByRole('button', { name: 'Inspect', exact: true }).click()
    const selected = page.locator('tr[aria-selected="true"]')
    const selectedKey = encodeURIComponent(`tool\u0000call\u0000${first.subCallId}`)
    await selected.filter({ hasText: 'bash' }).waitFor()
    expect(await selected.getAttribute('data-trajectory-row-key')).toBe(selectedKey)
    expect(await selected.getAttribute('data-kind')).toBe('tool')
    await page.getByRole('complementary', { name: 'Event details' }).waitFor()
    await page.getByRole('tab', { name: 'Result', exact: true }).click()
    await page.getByRole('region', { name: 'Rendered result', exact: true }).getByText('CODE_ROUND_OK', { exact: true }).waitFor()
    if (outcome === 'complete') {
      const approvalChild = { ...first, subCallId: ToolCallId(`${first.subCallId}:approval`) }
      session.append('tool/ptc-dispatch-start', approvalChild)
      const agent = scaffold.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('approval requires the active agent')
      owned.approval = scaffold.ctx.approval.request({
        agent, toolName: 'bash', callId: approvalChild.subCallId, signal: approvalAbort.signal,
      })
      const approval = page.locator('[data-approval-key]')
      await approval.getByText('echo CODE_ROUND_OK', { exact: true }).waitFor()
      const approvalKey = await approval.getAttribute('data-approval-key')
      const approvalAria = await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)
      session.append('tool/ptc-dispatch', { ...failed.data, subCallId: second.subCallId })
      release.resolve(undefined)
      await expect.poll(() => selected.getAttribute('data-kind')).toBe('subtool')
      expect(await approval.getAttribute('data-approval-key')).toBe(approvalKey)
      await expect.poll(() => approval.textContent()).toContain('echo CODE_ROUND_OK')
      expect(await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)).toBe(approvalAria)
      await compareOrRefreshGolden(join(DIRECTORY, 'approval.expected.md'), approvalAria, MODE)
      await approval.getByRole('button', { name: 'Reject', exact: true }).click()
      expect(await owned.approval).toBe('rejected')
      session.append('tool/ptc-dispatch', {
        ...approvalChild, isError: true, content: [{ type: 'text', text: 'Error: the user rejected tool "bash"' }],
      })
      continuation.resolve(undefined)
    }
    else await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    const sessionId = await settled
    await expect.poll(() => selected.evaluateAll(rows => rows.map(row => row.getAttribute('data-trajectory-row-key')))).toEqual([selectedKey])
    if (outcome === 'complete') await expect.poll(() => selected.getAttribute('data-kind')).toBe('subtool')
    await page.getByRole('complementary', { name: 'Event details' }).waitFor()
    await page.getByRole('region', { name: 'Rendered result', exact: true }).getByText('CODE_ROUND_OK', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    const persisted = await readPersistedEvents(scaffold, sessionId)
    const startAt = persisted.findIndex(event => event.type === 'tool/ptc-dispatch-start')
    const rootAt = persisted.findIndex(event => event.type === 'tool/call')
    expect(startAt).toBeGreaterThan(-1)
    if (outcome === 'complete') expect(rootAt).toBeGreaterThan(startAt)
    else expect(rootAt).toBe(-1)
    expect(persisted.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: outcome === 'stop' ? 'aborted' : 'completed' } } })
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expandOwningTurnProcess(page, child)
    await child.waitFor({ state: 'visible' })
    expect(await page.locator(`[data-chat-call-id="${first.subCallId}"]`).count()).toBe(1)
    expect(await page.locator(`[data-chat-call-id="${second.subCallId}"]`).count()).toBe(1)
    const calls = page.locator('[data-chat-flow-kind="tool-call"]')
    await compareOrRefreshGolden(join(DIRECTORY, `${outcome}.expected.md`),
      await captureStableAria(page, '[data-chat-flow-kind="tool-call"]', scaffold.workspaceCwd), MODE)
    expect(await calls.count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the borrowed recording and output inventory explicit', async () => {
    await assertFixtureInventory(DIRECTORY, ['complete.expected.md', 'stop.expected.md', 'approval.expected.md'])
  })
})
