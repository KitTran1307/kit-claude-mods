import { expect, test } from 'claude-code/testing'

import { readConfig } from './config'
import { MIN_CLAUDE_VERSION, compareVersions, report } from './doctor'
import type { Facts } from './doctor'
import { TABLES } from './i18n'

const OK: Facts = { version: '2.1.331', surfaces: ['terminal'], store: 'ok', quotaPct: 40 }
const cfg = readConfig({})
const en = TABLES.en
const vi = TABLES.vi

test('the minimum version is the one usage-bar documents', () => {
  expect(MIN_CLAUDE_VERSION).toBe('2.1.275')
})

test('compareVersions: order, a v prefix, a suffix, and nonsense', () => {
  expect(compareVersions('2.1.275', '2.1.275')).toBe(0)
  expect(compareVersions('2.1.274', '2.1.275')).toBe(-1)
  expect(compareVersions('2.2.0', '2.1.275')).toBe(1)
  expect(compareVersions('v10.0.0', '9.9.9')).toBe(1)
  expect(compareVersions('2.1.331-dev.4', '2.1.275')).toBe(1)
  expect(compareVersions('latest', '2.1.275')).toBeNull()
  expect(compareVersions('2.1.275', '')).toBeNull()
})

test('everything fine: four PASS lines in a fixed order, no hidden-pet line', () => {
  expect(report(OK, cfg, en)).toEqual([
    'PASS version - Claude Code 2.1.331 works with the pet',
    'PASS surfaces - the pet can show on: terminal',
    "PASS save - your pet's progress is saved and readable",
    'PASS limits - limit data is available (40% used)',
  ])
})

test('version: exactly the minimum passes, older fails, unknown or unreadable warns', () => {
  expect(report({ ...OK, version: MIN_CLAUDE_VERSION }, cfg, en)[0]).toMatch(/^PASS version - /)
  expect(report({ ...OK, version: '2.1.274' }, cfg, en)[0]).toBe('FAIL version - Claude Code 2.1.274 is older than 2.1.275.')
  expect(report({ ...OK, version: '1.0.0' }, cfg, en)[0]).toMatch(/^FAIL version - /)
  expect(report({ ...OK, version: null }, cfg, en)[0]).toBe(`WARN version - ${en.command.doctor.versionUnknown}`)
  expect(report({ ...OK, version: 'dev' }, cfg, en)[0]).toMatch(/^WARN version - /)
})

test('surfaces: several are listed, none is a WARN', () => {
  expect(report({ ...OK, surfaces: ['terminal', 'desktop', 'mobile'] }, cfg, en)[1]).toBe('PASS surfaces - the pet can show on: terminal, desktop, mobile')
  expect(report({ ...OK, surfaces: [] }, cfg, en)[1]).toBe(`WARN surfaces - ${en.command.doctor.noSurface}`)
})

test('save: readable is PASS, unreadable or unwritable is a WARN (progress lives in memory), never a FAIL', () => {
  expect(report({ ...OK, store: 'bad' }, cfg, en)[2]).toBe(`WARN save - ${en.command.doctor.storeBad}`)
})

test('limits: unknown data is informational (PASS), known data shows the percent', () => {
  expect(report({ ...OK, quotaPct: null }, cfg, en)[3]).toBe(`PASS limits - ${en.command.doctor.quotaUnknown}`)
  expect(report({ ...OK, quotaPct: 0 }, cfg, en)[3]).toBe('PASS limits - limit data is available (0% used)')
})

test('showPet off adds one WARN band line at the end', () => {
  const lines = report(OK, readConfig({ showPet: false }), en)
  expect(lines).toHaveLength(5)
  expect(lines[4]).toBe('WARN band - the pet is hidden: showPet.')
})

test('the worst case still never contains a FAIL other than an old version', () => {
  const lines = report({ version: null, surfaces: [], store: 'bad', quotaPct: null }, readConfig({ showPet: false }), en)
  expect(lines.filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(lines.filter(l => l.startsWith('WARN'))).toHaveLength(4)
})

test('Vietnamese sentences, check names stay English', () => {
  const lines = report(OK, cfg, vi)
  expect(lines[0]).toBe('PASS version - Claude Code 2.1.331 chạy được với thú cưng')
  expect(lines.map(l => l.split(' ')[1])).toEqual(['version', 'surfaces', 'save', 'limits'])
})

test('lines carry no path, no email and no token-looking text', () => {
  const text = report(OK, cfg, en).join('\n')
  expect(text).not.toMatch(/[\\/]|@|sk-|token/i)
})
