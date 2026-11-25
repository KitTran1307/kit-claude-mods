import { expect, test } from 'claude-code/testing'

import type { PluginOptions } from 'claude-code'

import { readConfig } from './config'

// Options come from a settings file, so a test may hand over values of the wrong type on purpose.
const odd = (o: Record<string, unknown>): PluginOptions => o as unknown as PluginOptions

test('options: defaults when nothing is set', () => {
  const defaults = { showPet: true, pet: 'moss', achievements: true, language: 'auto' }
  expect(readConfig({})).toEqual(defaults)
  expect(readConfig(undefined)).toEqual(defaults)
})

test('options: pet accepts the three pets, anything else is Moss', () => {
  expect(readConfig({ pet: 'moss' }).pet).toBe('moss')
  expect(readConfig({ pet: 'bun' }).pet).toBe('bun')
  expect(readConfig({ pet: 'jelly' }).pet).toBe('jelly')
  for (const v of ['cat', '', 'MOSS', 'BUN', ' bun', 'jelly ', 5, true, null, {}, []]) {
    expect(readConfig(odd({ pet: v })).pet).toBe('moss')
  }
})

test('options: language accepts auto, en and vi, anything else is auto', () => {
  expect(readConfig({ language: 'auto' }).language).toBe('auto')
  expect(readConfig({ language: 'en' }).language).toBe('en')
  expect(readConfig({ language: 'vi' }).language).toBe('vi')
  for (const v of ['fr', 'VI', ' vi', 'en ', '', 1, false, null, {}]) {
    expect(readConfig(odd({ language: v })).language).toBe('auto')
  }
})

test('options: showPet and achievements are on unless set to false', () => {
  expect(readConfig({ showPet: false, achievements: false })).toMatchObject({ showPet: false, achievements: false })
  expect(readConfig({ showPet: true, achievements: true })).toMatchObject({ showPet: true, achievements: true })
  for (const v of ['false', 'no', 0, null, {}, []]) {
    expect(readConfig(odd({ showPet: v, achievements: v }))).toMatchObject({ showPet: true, achievements: true })
  }
})

test('options: hostile values never throw', () => {
  const hostile = { showPet: {}, pet: { toString: () => 'bun' }, achievements: [], language: null, extra: 1 }
  expect(readConfig(odd(hostile))).toEqual({ showPet: true, pet: 'moss', achievements: true, language: 'auto' })
})
