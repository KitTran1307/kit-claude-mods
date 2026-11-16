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
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))

    if (unpainted !== undefined) {
      $.ui.toast(unpainted)
    }
    const set = await $.theme.set(LOOK)

    // A requestId means the theme stands and draws once the desktop or mobile
    // client attaches (it attaches after session.start), so only a real miss shows.
    if (!set.isDrawn && set.requestId === undefined) {
      $.ui.status(set.reason)
    }

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== 'kit-graphite-waves') {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)

    return <Svg source={SCENE} alt="Lưới chấm than chì gợn sóng, một nhân vật nhỏ màu đất nung bay từ góc trái dưới lên góc phải trên rồi bay vòng" isInteractive />
  })
}
