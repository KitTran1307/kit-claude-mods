// The plugin's options (plugin.json userConfig), as register(on, options) receives them, made safe to use.
import type { PluginOptions } from 'claude-code'

import type { Lang, PetId } from './types'

export type Config = {
  showPet: boolean
  pet: PetId
  achievements: boolean
  /** `auto` follows the `language` setting of Claude Code (Vietnamese or else English). */
  language: 'auto' | Lang
}

export function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return {
    showPet: o.showPet !== false,
    pet: o.pet === 'bun' || o.pet === 'jelly' ? o.pet : 'moss',
    achievements: o.achievements !== false,
    language: o.language === 'en' || o.language === 'vi' ? o.language : 'auto',
  }
}
