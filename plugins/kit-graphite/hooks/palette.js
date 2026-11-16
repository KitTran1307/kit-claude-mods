// Graphite and smoke: neutral charcoal grays, a black accent by day and an ivory one by night.
export const DEF = {
  label: 'Kit graphite',
  roles: { danger: '#c0453a', success: '#4f8a5b', warning: '#b8862b', pro: '#7a68a6' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#e8e8e7',
        'surface-1': '#efefee',
        'surface-2': '#f7f7f6',
        'text-primary': '#141414',
        'text-secondary': '#3f3f3e',
        'text-muted': '#5f5f5d',
      },
    },
    roles: { accent: { seed: '#161616', fillShade: 850 } },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#141414',
        'surface-1': '#1b1b1b',
        'surface-2': '#222222',
        'surface-3': '#282828',
        'text-primary': '#f0efec',
        'text-secondary': '#c6c5c1',
        'text-muted': '#9d9c98',
      },
    },
    roles: { accent: { seed: '#161616', fillShade: 50 } },
  },
}
