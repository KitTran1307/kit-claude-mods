// Builds the make-colors definition of a theme from palettes.js. Plain JavaScript so scripts/contrast.mjs can use the
// same definition the plugin sends to the app (CI then checks what is painted, not only the palette).
import { PALETTES } from './palettes.js'

const lower = hex => hex.toLowerCase()

/** A status color as a role whose fill is exactly this color (shade 450 is pinned to it), so the app paints what the palette says. */
const pinned = color => ({ seed: lower(color), stops: { 450: lower(color) }, fillShade: 450 })

/** One mode's half of a make-colors definition, from a palette. */
export function half(p) {
  return {
    gray: {
      anchors: {
        'surface-0': lower(p.bg),
        'surface-1': lower(p.mode === 'dark' ? p.surf : p.bg),
        'surface-2': lower(p.mode === 'dark' ? p.user : p.surf),
        'surface-3': lower(p.mode === 'dark' ? p.user : p.surf),
        'text-primary': lower(p.tx),
        'text-secondary': lower(p.tx2),
        'text-muted': lower(p.cm),
      },
    },
    roles: {
      accent: pinned(p.ac),
      danger: pinned(p.roles.danger),
      success: pinned(p.roles.success),
      warning: pinned(p.roles.warning),
      pro: pinned(p.roles.pro),
    },
  }
}

const LABELS = { paper: 'Paper', contrast: 'High Contrast', night: 'Night' }

/** The make-colors definition of a theme (`auto`: Paper's light half and Night's dark half, so the app's own mode decides). */
export function definitionFor(theme) {
  if (theme === 'auto') {
    return { label: 'Themes', id: 'kit-themes', light: half(PALETTES.paper), dark: half(PALETTES.night) }
  }
  const p = PALETTES[theme]
  return {
    label: LABELS[theme],
    id: `kit-themes-${theme}`,
    only: p.mode,
    ...(theme === 'contrast' ? { contrast: 'more' } : {}),
    [p.mode]: half(p),
  }
}
