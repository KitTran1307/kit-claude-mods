// Every word Quota Coach shows, in English and Vietnamese. Both tables have the same keys (`Strings`), so a key missing
// from one fails tsc. Model names, numbers, units and slash commands are not words and stay as they are.

export type Lang = 'en' | 'vi'

export type Strings = {
  // tips
  tipContext: (pct: number, savePct: number) => string
  tipAgents: (count: number) => string
  tipCache: (idleMin: number, tokens: string) => string
  tipModel: (model: string) => string
  btnCompact: string
  btnSonnet: string
  btnWhy: string
  btnClose: string
  // the "why" card
  whyTitle: string
  whyCost: (last: string | null, avg: string | null) => string
  whyUnknown: string
  rowContext: string
  rowModel: string
  rowAgents: string
  rowCache: string
  rowTurn: string
  turnValue: (steps: number, tokens: string) => string
  contextValue: (tokens: string, window: string, pct: string) => string
  contextNote: (tokens: string) => string
  contextUnknown: string
  modelNote: (times: number) => string
  modelNoteCheap: string
  agentsValue: (running: number, last: number) => string
  agentsNote: string
  cacheWarm: (leftMin: number) => string
  cacheCold: (idleMin: number) => string
  cacheUnknown: string
  cacheNoteWarm: string
  cacheNoteCold: string
  btnCompactSave: (save: number) => string
  // the estimate
  estimate: (mid: string, low: string, high: string) => string
  estimateTail: (model: string, ctx: string, cacheExtra: string | null) => string
  // the command
  commandDescription: string
  commandUsage: string
  fillNotice: string
  fillBusy: string
  fillFailed: string
  compactDone: string
  compactSkipped: (why: string) => string
  compactFailed: string
  whyOpened: string
  reportPaneOpened: string
  // the report
  reportTitle: string
  reportSubtitle: (date: string, pct: string | null, windows: number) => string
  reportCounts: (sessions: number, tokens: string) => string
  reportSessions: string
  reportModels: string
  reportHours: string
  reportBusiest: (hour: number, value: string) => string
  reportTop: (tier: string, share: number) => string
  reportEmpty: string
  reportTokensOnly: string
  reportNote: string
  untitled: string
}

const en: Strings = {
  tipContext: (pct, save) => `Context is ${pct}% full and every message re-reads it: /compact could make later turns up to ~${save}% cheaper.`,
  tipAgents: count => `${count} subagents are running at once; each one reads its own context and uses your plan in parallel.`,
  tipCache: (min, tokens) => `The prompt cache is cold (idle ${min} min): your next message re-reads ~${tokens} tokens at full price.`,
  tipModel: model => `Your last turns were light work on ${model}: Sonnet would use far less of your plan for this.`,
  btnCompact: 'Compact',
  btnSonnet: 'Fill /model sonnet',
  btnWhy: 'Why?',
  btnClose: 'Close',
  whyTitle: 'Why did the last turn cost this?',
  whyCost: (last, avg) => (last !== null ? `~${last}% of 5H${avg !== null ? ` · average ${avg}%` : ''}` : avg !== null ? `average ${avg}% of 5H per turn` : 'cost not measured yet'),
  whyUnknown: 'Your plan shows no 5-hour usage here, so only token counts are known.',
  rowContext: 'Context',
  rowModel: 'Model',
  rowAgents: 'Subagents',
  rowCache: 'Cache',
  rowTurn: 'Last turn',
  turnValue: (steps, tokens) => `${steps} step${steps === 1 ? '' : 's'} · ${tokens} tokens`,
  contextValue: (tokens, window, pct) => `${tokens} / ${window} tokens (${pct}%)`,
  contextNote: tokens => `Every step re-sends the whole conversation (${tokens} tokens).`,
  contextUnknown: 'not known yet (send a message first)',
  modelNote: times => `About ${times}x Sonnet for the same amount of work.`,
  modelNoteCheap: 'Already one of the lighter models.',
  agentsValue: (running, last) => (running > 0 ? `${running} running now` : last > 0 ? `${last} ran in the last turn` : 'none'),
  agentsNote: 'Each subagent reads its own copy of the context.',
  cacheWarm: left => `warm (about ${left} min left)`,
  cacheCold: idle => `cold (idle ${idle} min)`,
  cacheUnknown: 'not known yet',
  cacheNoteWarm: 'Re-reading the conversation is discounted while the cache is warm.',
  cacheNoteCold: 'The cache has expired: re-reading is not discounted.',
  btnCompactSave: save => `/compact · saves up to ~${save}%`,
  estimate: (mid, low, high) => `This turn ${String(mid).startsWith('<') ? '' : '~'}${mid}% of 5H (${low}-${high}%)`,
  estimateTail: (model, ctx, extra) => `${model} · ctx ${ctx}${extra !== null ? ` · cache cold +${extra}%` : ''}`,
  commandDescription: 'What is using your plan limits, and what to do about it',
  commandUsage: 'Quota Coach: /quota why (why the last turn cost what it did), /quota report (today, by session, model and hour).',
  fillNotice: 'Typed it into the prompt: press Enter to switch.',
  fillBusy: 'Your prompt has text in it, so nothing was typed. When you are ready, send /model sonnet.',
  fillFailed: 'Could not type into the prompt right now.',
  compactDone: 'Compacted.',
  compactSkipped: why => `Not compacted: ${why}`,
  compactFailed: 'Could not compact right now.',
  whyOpened: 'Showing why the last turn cost what it did, above the prompt.',
  reportPaneOpened: "Today's report is open in the side pane.",
  reportTitle: "Today's report",
  reportSubtitle: (date, pct, windows) => `${date}${pct !== null ? ` · 5H used ${pct}%` : ''}${windows > 0 ? ` · ${windows} window${windows === 1 ? '' : 's'}` : ''}`,
  reportCounts: (sessions, tokens) => `${sessions} session${sessions === 1 ? '' : 's'} · ${tokens} tokens`,
  reportSessions: 'SESSIONS',
  reportModels: 'BY MODEL',
  reportHours: 'BY HOUR',
  reportBusiest: (hour, value) => `${hour}h is the busiest hour (${value}).`,
  reportTop: (tier, share) => `${tier} is ${share}% of today's use.`,
  reportEmpty: 'Nothing recorded today yet.',
  reportTokensOnly: 'Your plan shows no 5-hour window here, so the report counts tokens.',
  reportNote: 'Percentages are of your 5-hour window, measured while Quota Coach ran. Everything stays on this computer.',
  untitled: '(untitled)',
}

const vi: Strings = {
  tipContext: (pct, save) => `Ngữ cảnh đã đầy ${pct}% và mỗi tin nhắn đều đọc lại toàn bộ: /compact có thể giúp các lượt sau rẻ hơn tới ~${save}%.`,
  tipAgents: count => `${count} subagent đang chạy cùng lúc; mỗi cái đọc ngữ cảnh riêng và dùng quota song song.`,
  tipCache: (min, tokens) => `Cache đã nguội (nghỉ ${min} phút): tin nhắn tiếp theo sẽ đọc lại ~${tokens} token với giá đầy đủ.`,
  tipModel: model => `Mấy lượt gần đây là việc nhẹ mà đang dùng ${model}: Sonnet sẽ tốn quota ít hơn nhiều.`,
  btnCompact: 'Nén',
  btnSonnet: 'Điền /model sonnet',
  btnWhy: 'Vì sao?',
  btnClose: 'Đóng',
  whyTitle: 'Vì sao lượt trước tốn?',
  whyCost: (last, avg) => (last !== null ? `~${last}% quota 5H${avg !== null ? ` · trung bình ${avg}%` : ''}` : avg !== null ? `trung bình ${avg}% quota 5H mỗi lượt` : 'chưa đo được chi phí'),
  whyUnknown: 'Gói của bạn không có số liệu 5 giờ ở đây, nên chỉ biết số token.',
  rowContext: 'Ngữ cảnh',
  rowModel: 'Model',
  rowAgents: 'Subagent',
  rowCache: 'Cache',
  rowTurn: 'Lượt trước',
  turnValue: (steps, tokens) => `${steps} bước · ${tokens} token`,
  contextValue: (tokens, window, pct) => `${tokens} / ${window} token (${pct}%)`,
  contextNote: tokens => `Mỗi bước gửi lại toàn bộ cuộc trò chuyện (${tokens} token).`,
  contextUnknown: 'chưa biết (hãy gửi một tin nhắn trước)',
  modelNote: times => `Đắt gấp ~${times} lần Sonnet cho cùng khối lượng việc.`,
  modelNoteCheap: 'Đã là một trong các model nhẹ.',
  agentsValue: (running, last) => (running > 0 ? `${running} đang chạy` : last > 0 ? `${last} đã chạy trong lượt vừa rồi` : 'không có'),
  agentsNote: 'Mỗi subagent đọc bản sao ngữ cảnh của riêng nó.',
  cacheWarm: left => `còn nóng (còn khoảng ${left} phút)`,
  cacheCold: idle => `nguội (nghỉ ${idle} phút)`,
  cacheUnknown: 'chưa biết',
  cacheNoteWarm: 'Đọc lại cuộc trò chuyện được giảm giá khi cache còn nóng.',
  cacheNoteCold: 'Cache đã hết hạn: đọc lại không được giảm giá.',
  btnCompactSave: save => `/compact · tiết kiệm tới ~${save}%`,
  estimate: (mid, low, high) => `Lượt này ${String(mid).startsWith('<') ? '' : '~'}${mid}% quota 5H (${low}-${high}%)`,
  estimateTail: (model, ctx, extra) => `${model} · ctx ${ctx}${extra !== null ? ` · cache nguội +${extra}%` : ''}`,
  commandDescription: 'Cái gì đang ăn quota của bạn, và nên làm gì',
  commandUsage: 'Quota Coach: /quota why (vì sao lượt trước tốn), /quota report (hôm nay theo phiên, model và giờ).',
  fillNotice: 'Đã điền vào ô nhập: bấm Enter để đổi.',
  fillBusy: 'Ô nhập đang có chữ nên chưa điền gì. Khi sẵn sàng, hãy gửi /model sonnet.',
  fillFailed: 'Chưa điền được vào ô nhập lúc này.',
  compactDone: 'Đã nén.',
  compactSkipped: why => `Chưa nén: ${why}`,
  compactFailed: 'Chưa nén được lúc này.',
  whyOpened: 'Đang hiện vì sao lượt trước tốn, phía trên ô nhập.',
  reportPaneOpened: 'Báo cáo hôm nay đang mở ở ngăn bên cạnh.',
  reportTitle: 'Báo cáo hôm nay',
  reportSubtitle: (date, pct, windows) => `${date}${pct !== null ? ` · quota 5H đã dùng ${pct}%` : ''}${windows > 0 ? ` · ${windows} cửa sổ` : ''}`,
  reportCounts: (sessions, tokens) => `${sessions} phiên · ${tokens} token`,
  reportSessions: 'PHIÊN',
  reportModels: 'THEO MODEL',
  reportHours: 'THEO GIỜ',
  reportBusiest: (hour, value) => `${hour}h là giờ tốn nhất (${value}).`,
  reportTop: (tier, share) => `${tier} chiếm ${share}% mức dùng hôm nay.`,
  reportEmpty: 'Hôm nay chưa ghi nhận gì.',
  reportTokensOnly: 'Gói của bạn không có cửa sổ 5 giờ ở đây, nên báo cáo đếm token.',
  reportNote: 'Phần trăm là của cửa sổ 5 giờ, đo trong lúc Quota Coach chạy. Mọi thứ ở lại trên máy này.',
  untitled: '(chưa đặt tên)',
}

export const TABLES: Record<Lang, Strings> = { en, vi }

/** Vietnamese when Claude Code's `language` setting says so (`Vietnamese`, `vi`, `Tiếng Việt`), English otherwise. */
export function languageFromSetting(settings: unknown): Lang {
  const value = settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>).language : settings
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === 'vi' || text.startsWith('vietnam') || text.startsWith('tiếng việt') || text.startsWith('tieng viet') ? 'vi' : 'en'
}
