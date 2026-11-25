// Every word the pet says, in English and Vietnamese. Both tables have the same keys (`Strings`), so a key missing
// from one fails tsc. Numbers, units (`2m 41s`, `92%`) and tool names are not words and stay as they are.
import type { AchievementId, Lang, PetId, PetState } from './types'

export type { Lang }

export type Strings = {
  petName: Record<PetId, string>
  /** Names of the three growth stages of each pet. */
  stageName: Record<PetId, readonly [string, string, string]>
  /** The pill text, short and uppercase. */
  stateLabel: Record<PetState, string>
  /** First line of the band, one per state. `clock` is `02:41`, `duration` is `2m 41s`. */
  idle: (name: string) => string
  working: (name: string, clock: string) => string
  done: (name: string, duration: string) => string
  errorTool: (name: string) => string
  errorTurn: (name: string) => string
  quota: (name: string, pct: number, window: 'five_hour' | 'seven_day') => string
  /** Second line of the band. `left` is the turns until the next stage, null at full growth. */
  lineIdle: (today: number, stageName: string) => string
  lineProgress: (left: number | null, name: string) => string
  lineWorking: (steps: number, last: string) => string
  lineDone: (total: number, left: number | null, name: string) => string
  lineError: () => string
  lineQuota: (reset: string) => string
  /** The one-row layout. */
  narrow: (name: string, state: string, extra: string) => string
  achievement: Record<AchievementId, { title: string; text: (name: string) => string }>
  /** The achievement toast, one string. */
  toast: (title: string, text: string) => string
  /** The `/pet` command: what the menu shows, the status and the doctor's sentences (check names stay English). */
  command: CommandStrings
}

export type CommandStrings = {
  description: string
  usage: string
  status: (a: { name: string; stage: string; turns: number; left: number | null; streak: number; unlocked: string[]; quota: string }) => string
  doctor: DoctorStrings
}

export type DoctorStrings = {
  /** Prefix of a fix hint. */
  fix: string
  versionOk: (v: string) => string
  versionOld: (v: string, min: string) => string
  versionUnknown: string
  surfaces: (list: string) => string
  noSurface: string
  storeOk: string
  storeBad: string
  quotaKnown: (pct: number) => string
  quotaUnknown: string
  hidden: (reasons: string) => string
}

const turnsEn = (n: number): string => `${n} ${n === 1 ? 'turn' : 'turns'}`
const stepsEn = (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'}`

export const en: Strings = {
  petName: { moss: 'Moss', bun: 'Bun', jelly: 'Jelly' },
  stageName: {
    moss: ['Sprout', 'Little Moss', 'Blooming Moss'],
    bun: ['Dough', 'Little Bun', 'Golden Bun'],
    jelly: ['Droplet', 'Little Jelly', 'Glow Jelly'],
  },
  stateLabel: { idle: 'IDLE', working: 'WORKING', done: 'DONE', error: 'ERROR', quota: 'LOW QUOTA' },
  idle: name => `${name} is waiting for your next task`,
  working: (name, clock) => `${name} is on it · ${clock}`,
  done: (_name, duration) => `All done! Took ${duration}`,
  errorTool: name => `A step failed. ${name} looks a little sad`,
  errorTurn: name => `That turn did not finish. ${name} looks a little sad`,
  quota: (name, pct, window) => `${window === 'five_hour' ? '5-hour' : 'Weekly'} limit is ${pct}% used. ${name} is out of breath`,
  lineIdle: (today, stageName) => `${today === 0 ? 'Nothing finished yet today' : `${turnsEn(today)} finished today`} · ${stageName}`,
  lineProgress: (left, name) => (left === null ? 'Fully grown' : `${left} more ${left === 1 ? 'turn' : 'turns'} until ${name} grows`),
  lineWorking: (steps, last) => (steps <= 0 ? 'Getting started…' : `${stepsEn(steps)} so far${last ? ` · last: ${last}` : ''}`),
  lineDone: (total, left, name) => `Turn #${total}${left === null ? '' : ` · ${left} more until ${name} grows`}`,
  lineError: () => 'Ask Claude to fix it, or just send a new message',
  lineQuota: reset => `${reset ? `Refills in ${reset} · ` : ''}a good time for a break or a light task`,
  narrow: (name, state, extra) => `${name} · ${state}${extra ? ` · ${extra}` : ''}`,
  achievement: {
    streak7: { title: 'Seven-day streak', text: name => `You used Claude 7 days in a row. ${name} is cheering you on.` },
    turns100: { title: '100 turns finished', text: name => `You finished 100 turns together. ${name} is proud of you.` },
    firstTest: { title: 'First green test run', text: name => `Your tests passed for the first time. ${name} does a little dance.` },
    firstCommit: { title: 'First commit', text: name => `Your first commit is saved. ${name} cheers you on.` },
  },
  toast: (title, text) => `★ Achievement: ${title}. ${text}`,
  command: {
    description: 'Check on your pet, or run a quick health check',
    usage: 'Usage: /pet  or  /pet doctor',
    status: a =>
      [
        `${a.name} · ${a.stage}`,
        `Turns finished: ${a.turns}${a.left === null ? ' (fully grown)' : ` · ${a.left} more until the next stage`}`,
        `Day streak: ${a.streak}`,
        `Achievements: ${a.unlocked.length ? a.unlocked.join(', ') : 'none yet'}`,
        ...(a.quota ? [`Limit: ${a.quota}`] : []),
      ].join('\n'),
    doctor: {
      fix: 'Fix:',
      versionOk: v => `Claude Code ${v} works with the pet`,
      versionOld: (v, min) => `Claude Code ${v} is older than ${min}.`,
      versionUnknown: 'could not tell which Claude Code version this is.',
      surfaces: list => `the pet can show on: ${list}`,
      noSurface: 'this screen has no place for the pet band, so it stays hidden here.',
      storeOk: 'your pet\'s progress is saved and readable',
      storeBad: 'your pet\'s progress could not be saved or read.',
      quotaKnown: pct => `limit data is available (${pct}% used)`,
      quotaUnknown: 'limit data is not available (API key or this surface): the low-quota state stays hidden, nothing to fix',
      hidden: reasons => `the pet is hidden: ${reasons}.`,
    },
  },
}

export const vi: Strings = {
  petName: { moss: 'Rêu', bun: 'Bao', jelly: 'Sứa' },
  stageName: {
    moss: ['Hạt mầm', 'Rêu con', 'Rêu nở hoa'],
    bun: ['Bột', 'Bao con', 'Bao vàng'],
    jelly: ['Giọt nước', 'Sứa con', 'Sứa phát sáng'],
  },
  stateLabel: { idle: 'RẢNH', working: 'ĐANG LÀM', done: 'XONG', error: 'LỖI', quota: 'SẮP HẾT' },
  idle: name => `${name} đang ngồi chờ bạn giao việc`,
  working: (name, clock) => `${name} đang chạy · ${clock}`,
  done: (_name, duration) => `Xong rồi! Mất ${duration}`,
  errorTool: name => `Có một bước bị lỗi. ${name} hơi buồn`,
  errorTurn: name => `Lượt này chưa chạy xong. ${name} hơi buồn`,
  quota: (name, pct, window) => `Hạn mức ${window === 'five_hour' ? '5 giờ' : 'tuần'} đã dùng ${pct}% — ${name} thở dốc`,
  lineIdle: (today, stageName) => `${today === 0 ? 'Hôm nay chưa xong lượt nào' : `Hôm nay xong ${today} lượt`} · ${stageName}`,
  lineProgress: (left, name) => (left === null ? 'Đã lớn hết cỡ' : `Còn ${left} lượt nữa là ${name} lớn`),
  lineWorking: (steps, last) => (steps <= 0 ? 'Đang bắt đầu…' : `Đã làm ${steps} bước${last ? ` · vừa rồi: ${last}` : ''}`),
  lineDone: (total, left, name) => `Lượt thứ ${total}${left === null ? '' : ` · còn ${left} lượt nữa là ${name} lớn`}`,
  lineError: () => 'Nhờ Claude sửa giúp, hoặc cứ gửi tin nhắn mới',
  lineQuota: reset => `${reset ? `Đầy lại sau ${reset} · ` : ''}hợp để nghỉ một chút hoặc làm việc nhẹ`,
  narrow: (name, state, extra) => `${name} · ${state}${extra ? ` · ${extra}` : ''}`,
  achievement: {
    streak7: { title: '7 ngày liên tục', text: name => `Bạn dùng Claude 7 ngày liền, ${name} vui lắm.` },
    turns100: { title: 'Xong 100 lượt', text: name => `Hai bạn đã làm xong 100 lượt. ${name} tự hào về bạn.` },
    firstTest: { title: 'Lần đầu test xanh', text: name => `Lần đầu các bài test đều qua. ${name} nhảy nhót vui mừng.` },
    firstCommit: { title: 'Commit đầu tiên', text: name => `Commit đầu tiên của bạn đã được lưu. ${name} cổ vũ bạn.` },
  },
  toast: (title, text) => `★ Thành tựu mới: ${title}. ${text}`,
  command: {
    description: 'Xem thú cưng của bạn, hoặc kiểm tra nhanh',
    usage: 'Cách dùng: /pet  hoặc  /pet doctor',
    status: a =>
      [
        `${a.name} · ${a.stage}`,
        `Số lượt đã xong: ${a.turns}${a.left === null ? ' (đã lớn hết cỡ)' : ` · còn ${a.left} lượt nữa là lên cấp`}`,
        `Chuỗi ngày liên tục: ${a.streak}`,
        `Thành tựu: ${a.unlocked.length ? a.unlocked.join(', ') : 'chưa có'}`,
        ...(a.quota ? [`Hạn mức: ${a.quota}`] : []),
      ].join('\n'),
    doctor: {
      fix: 'Cách sửa:',
      versionOk: v => `Claude Code ${v} chạy được với thú cưng`,
      versionOld: (v, min) => `Claude Code ${v} cũ hơn ${min}.`,
      versionUnknown: 'không xác định được phiên bản Claude Code.',
      surfaces: list => `thú cưng có thể hiện ở: ${list}`,
      noSurface: 'màn hình này không có chỗ cho thú cưng nên sẽ ẩn ở đây.',
      storeOk: 'tiến trình của thú cưng được lưu và đọc được',
      storeBad: 'không lưu hoặc đọc được tiến trình của thú cưng.',
      quotaKnown: pct => `có dữ liệu hạn mức (đã dùng ${pct}%)`,
      quotaUnknown: 'chưa có dữ liệu hạn mức (dùng API key hoặc màn hình này không có): trạng thái sắp hết sẽ ẩn, không cần sửa gì',
      hidden: reasons => `thú cưng đang ẩn: ${reasons}.`,
    },
  },
}

export const TABLES: Readonly<Record<Lang, Strings>> = { en, vi }

/**
 * The language a `language` value from the settings names: Vietnamese ("vi", "vi-VN", "Vietnamese", "Tiếng Việt"),
 * anything else, a missing value or a value that is not text: English.
 */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.trim().normalize('NFC')) ? 'vi' : 'en'
}
