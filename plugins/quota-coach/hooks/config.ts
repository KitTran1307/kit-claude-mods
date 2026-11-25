// The plugin's options (plugin.json userConfig), as register(on, options) receives them, made safe to use.
import type { PluginOptions } from 'claude-code'

import type { Lang } from './i18n'

export type Config = {
  language: 'auto' | Lang
  tips: boolean
  estimate: boolean
  contextTipPercent: number
}

export const DEFAULT_CONTEXT_TIP_PERCENT = 70

export function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  const pct = typeof o.contextTipPercent === 'number' && Number.isFinite(o.contextTipPercent) ? o.contextTipPercent : DEFAULT_CONTEXT_TIP_PERCENT
  return {
    language: o.language === 'en' || o.language === 'vi' ? o.language : 'auto',
    tips: o.tips !== false,
    estimate: o.estimate !== false,
    contextTipPercent: Math.min(95, Math.max(30, pct)),
  }
}
