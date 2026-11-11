// @vitest-environment jsdom
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalCommand, commandOf } from '../src/client/chat/ApprovalCommand.tsx'

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
): PropsRuntime<'conversation.approval.detail'> {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat } as PropsRuntime<'conversation.approval.detail'>
}

describe('commandOf', () => {
  it('accepts only a string command from valid JSON arguments', () => {
    expect(commandOf(undefined)).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":42}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":"pnpm test"}' })).toBe('pnpm test')
  })
})

describe('ApprovalCommand', () => {
  it('renders the running correlated Tool command', () => {
    render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{"command":"wrong"}'), callId: 'other', argsRaw: '{"command":"wrong"}', subCalls: [] } } },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{"command":"pnpm test"}'), callId: 'call-1', argsRaw: '{"command":"pnpm test"}', subCalls: [] } } },
    ] as never)} />)

    expect(screen.getByText('pnpm test')).toBeTruthy()
  })

  it('omits absent, uncorrelated, preparing, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{}'), callId: 'other', argsRaw: '{}', subCalls: [] } } },
      { kind: 'tool-call', data: { root: { phase: 'preparing', args: PartialArguments.EMPTY, callId: 'call-1', name: 'bash', subCalls: [] } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}', subCalls: [] } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', args: PartialArguments.fromText('{}'), callId: 'call-1', argsRaw: '{}', subCalls: [] } } },
    ] as never)} />)
    expect(container.textContent).toBe('')
  })

  it('retains a pending child command as its ancestors arrive, then hides its settled result', () => {
    const child = { phase: 'start', callId: 'call-1', argsRaw: '{"command":"pwd"}', subCalls: [] }
    const { container, rerender } = render(<ApprovalCommand {...props([{ kind: 'tool-call', data: {
      root: { kind: 'tool-result', callId: 'first', subCalls: [] },
      siblings: [child],
    } }])} />)
    expect(screen.getByText('pwd')).toBeTruthy()
    const parent = { phase: 'preparing', callId: 'parent', subCalls: [child] }
    rerender(<ApprovalCommand {...props([{ kind: 'tool-call', data: { root: parent } }])} />)
    expect(screen.getByText('pwd')).toBeTruthy()
    const root = { phase: 'start', callId: 'root', argsRaw: '{}', subCalls: [parent] }
    rerender(<ApprovalCommand {...props([{ kind: 'tool-call', data: { root } }])} />)
    expect(screen.getByText('pwd')).toBeTruthy()
    rerender(<ApprovalCommand {...props([{ kind: 'tool-call', data: {
      root: { ...root, subCalls: [{ ...parent, subCalls: [{ ...child, kind: 'tool-result' }] }] },
    } }])} />)
    expect(container.textContent).toBe('')
  })
})
