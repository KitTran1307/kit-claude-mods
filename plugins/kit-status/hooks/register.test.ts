import { expect, test } from 'claude-code/testing'

import { endsOnQuestion, finishedIn, statusAtEnd, taskIdOf, withDot } from './register'

test('a title carries one dot, replaced as the status moves', () => {
  expect(withDot('Sidebar mod', 'run')).toBe('🔵 Sidebar mod')
  expect(withDot('🔵 Sidebar mod', 'wait')).toBe('⏳ Sidebar mod')
  expect(withDot('⏳ Sidebar mod', 'ask')).toBe('🟠 Sidebar mod')
  expect(withDot('🟠 Sidebar mod', 'done')).toBe('✅ Sidebar mod')
  expect(withDot('✅ Sidebar mod', 'done')).toBe('✅ Sidebar mod')
})

test('status where the session stops, and the ids it reads', () => {
  expect(endsOnQuestion('Đã deploy. Anh muốn kiểm trang thật bây giờ hay để sau?')).toBe(true)
  expect(statusAtEnd(false, 'Xong.', 0)).toBe('done')
  expect(statusAtEnd(false, 'Build đang chạy nền.', 1)).toBe('wait')
  expect(statusAtEnd(false, 'Chọn A hay B?', 1)).toBe('ask')
  expect(statusAtEnd(true, 'Xong.', 0)).toBe('ask')
  expect(taskIdOf({ stdout: 'Command running in background with ID: b1a1wv81c. Output is…' })).toBe('b1a1wv81c')
  expect(finishedIn('<task-notification>\n<task-id>b1</task-id>\n</task-notification><task-id>a9</task-id>')).toEqual(['b1', 'a9'])
})

test('a shell keeps the session waiting until its own notification', async ($, on) => {
  let title = 'Việc C'
  let agents: { status: string }[] = []
  on('mcp.call', (_, e) => {
    if (e.tool === 'set_session_title') title = (e.args as { title: string }).title
    return { value: { content: [{ type: 'text', text: JSON.stringify({ title }) }], isError: false } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: 'Command running in background with ID: b1.' } }) as never)
  on('clock.now', () => ({ value: 1000 }) as never)
  on('agent.list', () => ({ value: agents }) as never)
  const end = (turnId: string, answer: string) =>
    $.turn.complete({ turnId, answer, durationMs: 1, isAborted: false, reason: 'answer' })

  await $.turn.start({ text: 'build đi', turnId: 'c1' })
  expect(title).toBe('🔵 Việc C')
  await $.tool.call({ tool: 'Bash', command: 'npm run build', run_in_background: true } as never)
  agents = [{ status: 'running' }]
  await end('c1', 'Build và agent đang chạy nền.')
  expect(title).toBe('⏳ Việc C')

  // The agent finishes first: the shell still runs.
  agents = [{ status: 'completed' }]
  await $.turn.start({ text: '<task-notification><task-id>a9</task-id></task-notification>', turnId: 'c2' })
  expect(title).toBe('🔵 Việc C')
  await end('c2', 'Agent xong, build vẫn chạy.')
  expect(title).toBe('⏳ Việc C')

  await $.turn.start({ text: '<task-notification><task-id>b1</task-id></task-notification>', turnId: 'c3' })
  await end('c3', 'Build xong.')
  expect(title).toBe('✅ Việc C')

  await $.turn.start({ text: 'tiếp', turnId: 'c4' })
  await end('c4', 'Anh chọn cách nào?')
  expect(title).toBe('🟠 Việc C')
})
