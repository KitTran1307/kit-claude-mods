import type { Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'
import { DEF } from './palette.js'
import { SCENE } from './scene'

const { theme, problems } = makeColors(DEF)

const LOOK: ThemeSetArgs = {
  colors: theme,
  backdrop: { scene: 'kit-graphite-waves', glass: { blur: 0, opacity: 0.45 } },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))

      if (unpainted !== undefined) {
        $.ui.toast(unpainted)
      }
      const set = await $.theme.set(LOOK)

      // A requestId means the theme stands and draws once the desktop or mobile client attaches (after
      // session.start). With none, nothing here draws themes (a terminal-only session): the terminal keeps its
      // look, as the README says, so the reason goes to the debug log, not to the person every session.
      if (!set.isDrawn && set.requestId === undefined) {
        $.ui.log(`kit-graphite: theme not drawn: ${set.reason}`, { to: 'debug' })
      }
    } catch (err) {
      // An older Claude Code refuses the theme: keep its own look, and never fail the session's start hook.
      $.ui.log(`kit-graphite: theme not set: ${String(err)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== 'kit-graphite-waves') {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)

    return <Svg source={SCENE} alt="A graphite dot field frozen mid-wave, with a small clay-colored pixel comet circling the middle" isInteractive />
  })
}
