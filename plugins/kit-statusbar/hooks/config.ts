// The plugin's options (plugin.json userConfig), as register(on, options) receives them, made safe to use.
import type { PluginOptions } from 'claude-code'

import { DEFAULT_BUDGET_PER_DAY } from './format'
import { TABLES } from './i18n'
import type { Lang, Strings } from './i18n'

/**
 * Where the band draws. auto: the desktop app always, the terminal only when no status line is configured there
 * (so nobody sees the same facts twice). desktop: the desktop app only. desktop+terminal: both, always.
 */
export type Surfaces = 'auto' | 'desktop' | 'desktop+terminal'

/** The band's language: `auto` follows the `language` setting of Claude Code (Vietnamese or else English). */
export type Language = 'auto' | Lang

export type Config = {
  surfaces: Surfaces
  language: Language
  weeklyBudgetPerDay: number
  showEmail: boolean
  showTitle: boolean
  showLimits: boolean
  showHookErrors: boolean
  maxTranscriptMB: number
}

const DEFAULT_MAX_TRANSCRIPT_MB = 8

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return {
    surfaces: o.surfaces === 'desktop' || o.surfaces === 'desktop+terminal' ? o.surfaces : 'auto',
    language: o.language === 'en' || o.language === 'vi' ? o.language : 'auto',
    weeklyBudgetPerDay: num(o.weeklyBudgetPerDay, DEFAULT_BUDGET_PER_DAY),
    showEmail: o.showEmail !== false,
    showTitle: o.showTitle !== false,
    showLimits: o.showLimits !== false,
    showHookErrors: o.showHookErrors !== false,
    maxTranscriptMB: Math.max(1, num(o.maxTranscriptMB, DEFAULT_MAX_TRANSCRIPT_MB)),
  }
}

/**
 * Whether the band draws on a surface. `terminalHasStatusLine` is what the settings files say (see hasStatusLine);
 * null means not looked at yet, and `auto` then keeps out of the terminal rather than risk showing a status line twice.
 */
export const drawsOn = (cfg: Config, surface: string, terminalHasStatusLine: boolean | null = false): boolean => {
  if (surface === 'desktop') return true
  if (surface !== 'terminal') return false
  return cfg.surfaces === 'desktop+terminal' || (cfg.surfaces === 'auto' && terminalHasStatusLine === false)
}

/** What each answer of the once-asked question keeps: the key of its label in the language tables, and the `surfaces` value. */
export const STATUS_LINE_ANSWERS = [
  { key: 'answerKeepMine', surfaces: 'desktop' },
  { key: 'answerShowBoth', surfaces: 'desktop+terminal' },
] as const satisfies readonly { key: keyof Strings; surfaces: Surfaces }[]

/** The `surfaces` value an answer picks, whichever language it was asked in; anything else (free text under Other) picks nothing. */
export const surfacesForAnswer = (answer: string): Surfaces | null => {
  const text = answer.trim()
  return STATUS_LINE_ANSWERS.find(a => Object.values(TABLES).some(t => t[a.key] === text))?.surfaces ?? null
}

/** Whether a settings file's text configures a status line (`"statusLine": { "command": ... }`). Bad JSON: no. */
export function hasStatusLine(text: string | null | undefined): boolean {
  if (!text) return false
  try {
    const s = JSON.parse(text.replace(/^﻿/, '')) as { statusLine?: { command?: unknown; type?: unknown } | null }
    const line = s?.statusLine
    return !!line && typeof line === 'object' && typeof line.command === 'string' && line.command.trim() !== ''
  } catch {
    return false
  }
}

/** The settings files that can set a status line for a session: user (config folder) and project (cwd/.claude). */
export function statusLineFiles(configDir: string, cwd: string): string[] {
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  const out = [`${trim(configDir)}/settings.json`]
  if (cwd) out.push(`${trim(cwd)}/.claude/settings.json`, `${trim(cwd)}/.claude/settings.local.json`)
  return out
}
