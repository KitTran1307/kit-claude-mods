# Contrast check: current values

`node scripts/contrast.mjs` reads the colors from the plugin sources and checks WCAG 2.x contrast. Main text needs
7:1, secondary text 4.5:1 (the rules are at the top of the script). It runs in CI. Recorded on 2026-11-25 against the
plugin versions in this branch: **189 of 189 pairs pass**.

kit-graphite: every pair passes, light and dark. Lowest: pro label on pro fill 4.51:1 (dark) and 4.55:1 (light),
danger label on danger fill 4.71:1 and 4.75:1; all other pairs are 5.2:1 or more.

kit-themes: Paper, High Contrast and Night, 18 pairs each (text on page, sidebar, message box, your messages and bands;
the accent and its button label; code colors on the code block; the four status colors on the page). Main text needs
7:1 and secondary text 4.5:1; High Contrast is held to 7:1 on every pair (AAA). Lowest now: Paper's code string on the
code block 4.79:1 (4.5 needed); High Contrast's lowest is 10.34:1 (danger on the page); Night's lowest is 7.49:1 (secondary text on bands).
The same theme names marked "(painted)" hold what the app really draws, built by the plugin's own definition: each status color's button label on its fill and the gray text on every surface. Lowest painted: Paper 5.96:1 (success label), High Contrast 10.19:1 (muted text on your messages), Night 6.73:1 (muted text on your messages). The code-block, sidebar and band rows are palette values: the app builds code colors from the status colors and keeps its own sidebar shades.
Main text on page: Paper 14.3:1, High Contrast 21.0:1, Night 13.9:1.

usage-bar uses the Tokyo Night palette with four colors lightened (an owner decision, 2026-11-25) so that every pair
passes against all seven reference backgrounds (the band's own dark `#16161e`, pure black, `#0c0c0c`, `#121212`,
`#1a1b26`, `#1e1e1e`, `#282c34`):

| Color | Before | Now | Lowest ratio now |
| --- | --- | --- | --- |
| `T.comment` (secondary text, 4.5 needed) | `#565f89` (2.26 to 3.39) | `#8a93bd` | 4.66 on `#282c34`, 5.99 on `#16161e` |
| `T.red` (main text, 7 needed) | `#f7768e` (5.29 to 6.80) | `#ffa3b5` | 7.44 on `#282c34`, 9.56 on `#16161e` |
| `T.cyan` (model pill text on `T.hl2`) | `#7dcfff` (5.73) | `#a6e3ff` | 7.04 |
| `T.magenta` (effort pill text on `T.hl`) | `#bb9af7` (5.81) | `#d4bcff` | 7.95 |

The limits pill while the numbers are stale is drawn dim on purpose: `T.fg` `#c0caf5` on `T.hl2` `#3b4261` is 6.08:1,
held to the secondary rule (4.5). The account pill text `T.dark` on `T.red` is now 9.56:1.
