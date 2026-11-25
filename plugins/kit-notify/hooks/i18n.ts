// Every word kit-notify shows or says, in English and Vietnamese. Pure data and functions: no engine calls. `vi` is typed
// as `Strings` (the shape of `en`), so a key missing from either table fails tsc.
export type Lang = 'en' | 'vi'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const en = {
  commandDescription: 'Queue prompts while Claude works: /queue add <text> | list | remove <n> | clear | pause | resume | next',
  commandHint: '[add <text> | list | remove <n> | clear | pause | resume | next]',
  usage: 'Usage: /queue add <text> (or just /queue <text>) | /queue list | /queue remove <number> | /queue clear | /queue pause | /queue resume | /queue next (send the first now).',
  failed: 'Something went wrong with that, so nothing was changed.',
  nothingToAdd: 'Nothing to queue: type the prompt after /queue add.',
  tooLong: (max: number) => `That prompt is longer than ${max} characters, so it was not queued. Send it directly or split it.`,
  boxNotCleared: 'Queued, but the prompt box could not be emptied: clear it yourself so the same text is not sent twice.',
  full: (max: number) => `The queue is full (${max} prompts). Remove one or wait for Claude to work through them.`,
  queued: (n: number, text: string, isPaused: boolean) =>
    `Queued as number ${n}: ${text}${isPaused ? ' The queue is paused: /queue resume sends it.' : n === 1 ? ' It is sent when Claude is free.' : ''}`,
  listEmpty: 'The queue is empty. Add one with /queue add <text>.',
  listHead: (n: number, isPaused: boolean) => `${n} queued ${plural(n, 'prompt', 'prompts')}${isPaused ? ' (paused)' : ', sent one at a time when Claude is free'}:`,
  removed: (n: number, text: string) => `Removed number ${n}: ${text}`,
  noSuchItem: (arg: string) => `There is no number ${arg || '(none given)'} in the queue: /queue list shows the numbers.`,
  cleared: (n: number) => (n === 0 ? 'The queue was already empty.' : `Removed ${n} queued ${plural(n, 'prompt', 'prompts')}.`),
  paused: 'Queue paused: nothing is sent until /queue resume.',
  resumed: (n: number): string => (n === 0 ? 'Queue resumed (it is empty).' : 'Queue resumed: the next prompt goes out when Claude is free.'),
  sentNow: (text: string) => `Sending now: ${text}`,
  nothingToSend: 'The queue is empty, so there is nothing to send.',
  stoppedPause: 'You stopped Claude, so the queue is paused. /queue resume sends the rest.',
  notSent: 'The next queued prompt could not be sent, so the queue is paused. /queue resume tries again.',
  typeFirst: 'Type the prompt in the box first, then queue it.',
  queueTitle: (n: number, isPaused: boolean) =>
    `Queue · ${n} ${plural(n, 'prompt', 'prompts')} ${isPaused ? 'paused' : 'sent one at a time when Claude is free'}`,
  queueLine: (n: number, next: string, isPaused: boolean) => `${isPaused ? 'Queue paused' : 'Queue'} · ${n} waiting · next: ${next}`,
  idleLine: 'Claude is working. Queue what you typed to send it when Claude is free:',
  moreItems: (k: number) => `+${k} more: /queue list shows all`,
  buttons: {
    remove: '×',
    sendNow: 'Send the first now',
    pause: 'Pause',
    resume: 'Resume',
    clear: 'Clear all',
    addTyped: 'Queue what I typed',
    dismiss: 'Dismiss',
  },
  // notifications
  doneTitle: (project: string) => `Claude finished${project ? ` · ${project}` : ''}`,
  needsTitle: (project: string) => `Claude needs you${project ? ` · ${project}` : ''}`,
  doneBody: 'The work is ready for you to look at.',
  needsBody: 'Claude is waiting for your answer.',
  needsTool: (tool: string) => `Claude is asking permission to use ${tool}.`,
  // welcome back
  cardTitle: 'Welcome back',
  cardAway: (min: number, from: string, to: string) => `away ${duration(min)} (${from} → ${to})`,
  cardSummary: (min: number, done: number, questions: number) => {
    const parts = [
      ...(done > 0 ? [`${done} ${plural(done, 'task', 'tasks')} done`] : []),
      ...(questions > 0 ? [`${questions} ${plural(questions, 'question', 'questions')} waiting`] : []),
    ]
    return `While you were away ${duration(min)}: ${parts.join(', ')}`
  },
  doneRow: (text: string) => text || 'Claude finished a task',
  questionRow: (text: string) => text || 'Claude is waiting for your answer',
  cardMore: (k: number) => `+${k} more`,
}

function duration(min: number): string {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export type Strings = typeof en

const viPlural = (_n: number, word: string) => word

const vi: Strings = {
  commandDescription: 'Xếp hàng các lời nhắc khi Claude đang làm: /queue add <nội dung> | list | remove <số> | clear | pause | resume | next',
  commandHint: '[add <nội dung> | list | remove <số> | clear | pause | resume | next]',
  usage: 'Cách dùng: /queue add <nội dung> (hoặc chỉ /queue <nội dung>) | /queue list | /queue remove <số> | /queue clear | /queue pause | /queue resume | /queue next (gửi cái đầu ngay).',
  failed: 'Có lỗi nên chưa đổi gì.',
  nothingToAdd: 'Chưa có gì để xếp hàng: gõ lời nhắc sau /queue add.',
  tooLong: (max: number) => `Lời nhắc dài hơn ${max} ký tự nên chưa xếp hàng. Hãy gửi trực tiếp hoặc chia nhỏ.`,
  boxNotCleared: 'Đã xếp hàng, nhưng chưa xoá được ô nhập: hãy tự xoá để cùng một nội dung không bị gửi hai lần.',
  full: (max: number) => `Hàng chờ đã đầy (${max} việc). Hãy xoá bớt hoặc đợi Claude làm xong.`,
  queued: (n: number, text: string, isPaused: boolean) =>
    `Đã xếp hàng, số ${n}: ${text}${isPaused ? ' Hàng chờ đang tạm dừng: /queue resume để gửi tiếp.' : n === 1 ? ' Sẽ gửi khi Claude rảnh.' : ''}`,
  listEmpty: 'Hàng chờ đang trống. Thêm bằng /queue add <nội dung>.',
  listHead: (n: number, isPaused: boolean) => `${n} việc đang chờ${isPaused ? ' (tạm dừng)' : ', gửi lần lượt khi Claude rảnh'}:`,
  removed: (n: number, text: string) => `Đã xoá số ${n}: ${text}`,
  noSuchItem: (arg: string) => `Hàng chờ không có số ${arg || '(chưa nhập)'}: /queue list cho biết các số.`,
  cleared: (n: number) => (n === 0 ? 'Hàng chờ vốn đã trống.' : `Đã xoá ${n} việc đang chờ.`),
  paused: 'Đã tạm dừng hàng chờ: không gửi gì cho đến khi /queue resume.',
  resumed: (n: number) => (n === 0 ? 'Đã tiếp tục hàng chờ (đang trống).' : 'Đã tiếp tục hàng chờ: việc kế tiếp được gửi khi Claude rảnh.'),
  sentNow: (text: string) => `Đang gửi ngay: ${text}`,
  nothingToSend: 'Hàng chờ đang trống nên không có gì để gửi.',
  stoppedPause: 'Bạn đã dừng Claude nên hàng chờ tạm dừng. /queue resume để gửi phần còn lại.',
  notSent: 'Không gửi được việc kế tiếp nên hàng chờ tạm dừng. /queue resume để thử lại.',
  typeFirst: 'Hãy gõ lời nhắc vào ô nhập trước rồi mới xếp hàng.',
  queueTitle: (n: number, isPaused: boolean) =>
    `Hàng chờ · ${n} việc ${isPaused ? 'tạm dừng' : 'tự gửi lần lượt khi Claude rảnh'}`,
  queueLine: (n: number, next: string, isPaused: boolean) => `${isPaused ? 'Hàng chờ tạm dừng' : 'Hàng chờ'} · ${n} việc · tiếp theo: ${next}`,
  idleLine: 'Claude đang làm. Xếp hàng điều bạn vừa gõ để gửi khi Claude rảnh:',
  moreItems: (k: number) => `+${k} việc nữa: /queue list xem đủ`,
  buttons: {
    remove: '×',
    sendNow: 'Gửi cái đầu ngay',
    pause: 'Tạm dừng',
    resume: 'Tiếp tục',
    clear: 'Xoá hết',
    addTyped: 'Xếp hàng điều tôi vừa gõ',
    dismiss: 'Đóng',
  },
  doneTitle: (project: string) => `Claude xong việc${project ? ` · ${project}` : ''}`,
  needsTitle: (project: string) => `Claude cần bạn trả lời${project ? ` · ${project}` : ''}`,
  doneBody: 'Việc đã xong, bạn có thể xem kết quả.',
  needsBody: 'Claude đang chờ câu trả lời của bạn.',
  needsTool: (tool: string) => `Claude xin phép dùng ${tool}.`,
  cardTitle: 'Chào mừng bạn quay lại',
  cardAway: (min: number, from: string, to: string) => `vắng ${durationVi(min)} (${from} → ${to})`,
  cardSummary: (min: number, done: number, questions: number) => {
    const parts = [
      ...(done > 0 ? [`xong ${done} ${viPlural(done, 'việc')}`] : []),
      ...(questions > 0 ? [`${questions} ${viPlural(questions, 'câu hỏi')} chờ bạn`] : []),
    ]
    return `Trong lúc bạn đi ${durationVi(min)}: ${parts.join(', ')}`
  },
  doneRow: (text: string) => text || 'Claude đã xong một việc',
  questionRow: (text: string) => text || 'Claude đang chờ câu trả lời của bạn',
  cardMore: (k: number) => `+${k} mục nữa`,
}

function durationVi(min: number): string {
  if (min < 60) return `${min} phút`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} giờ` : `${h} giờ ${m} phút`
}

export const TABLES: Record<Lang, Strings> = { en, vi }

export const stringsFor = (lang: Lang): Strings => TABLES[lang]

/** Claude Code's own `language` setting ("Vietnamese", "vi", "Tiếng Việt", "vi-VN") as a UI language; anything else is English. */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.normalize('NFC').trim()) ? 'vi' : 'en'
}

/** The language option (auto | en | vi) and Claude Code's setting, as the language in use. */
export function chooseLanguage(option: unknown, setting: unknown): Lang {
  return option === 'en' || option === 'vi' ? option : languageFromSetting(setting)
}
