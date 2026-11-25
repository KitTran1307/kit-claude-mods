// The plain parts of what Quota Coach draws: colours, the tip's sentence, the report as plain text.
// (The trees themselves are drawn in register.tsx: JSX is only available in the hooks module.)
import { fmtTokens } from './calc'
import type { Estimate, Tip } from './calc'
import type { Strings } from './i18n'
import { lineText } from './report'
import type { Line } from './report'
import { prettyModel, tierLabel } from './model'


// Tokyo Night, as the other bands of this marketplace.
export const C = {
  dark: '#16161e', hl: '#292e42', hl2: '#3b4261', comment: '#8a93bd', fg: '#c0caf5',
  blue: '#7aa2f7', cyan: '#a6e3ff', magenta: '#d4bcff', orange: '#ff9e64',
  yellow: '#e0af68', green: '#9ece6a', teal: '#73daca', red: '#ffa3b5',
} as const

/** The tip's sentence. */
export function tipText(t: Strings, tip: Tip, model: string): string {
  switch (tip.kind) {
    case 'context': return t.tipContext(tip.pct, tip.savePct)
    case 'agents': return t.tipAgents(tip.count)
    case 'cache': return t.tipCache(tip.idleMin, fmtTokens(tip.tokens))
    case 'model': return t.tipModel(prettyModel(model) || tierLabel(tip.tier))
  }
}


export type TipHandlers = { onAction: (() => void) | null; actionLabel: string; onWhy: () => void; onDismiss: () => void }
export type WhyHandlers = { onCompact: () => void; onSonnet: () => void; onClose: () => void }
export type EstimateView = { est: Estimate; fivePct: number; model: string; ctxTokens: number; cold: boolean }

export const reportPlain = (lines: readonly Line[]): string => lines.map(lineText).join('\n')
