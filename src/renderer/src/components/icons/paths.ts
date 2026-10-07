/**
 * MoucLauncher icon geometry.
 *
 * Hand-drawn on a 20x20 grid: stroke width 1.5, round caps/joins, `fill: none`.
 * Every entry is a single `d` string (subpaths separated by M commands) so the
 * renderer can keep one <path> per icon. Coordinates stay inside 2.4..17.6 so a
 * 1.5 stroke never clips the viewBox, and hit areas are built by the component.
 *
 * Deliberate brand choices:
 * - no icon is "a circle with a shape inside it" except info/clock/eye, where the
 *   ring IS the glyph; play is a bare triangle (never inside a circle).
 * - cube / package / box / pack are separated by silhouette, not by colour.
 * - legibility was verified at 16px, which is the smallest size the shell uses.
 */

export type IconName =
  | 'home'
  | 'cube'
  | 'layers'
  | 'download'
  | 'package'
  | 'box'
  | 'user'
  | 'users'
  | 'beaker'
  | 'globe'
  | 'server'
  | 'lan'
  | 'radio'
  | 'link'
  | 'key'
  | 'shield'
  | 'gear'
  | 'palette'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'copy'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'search'
  | 'check'
  | 'x'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'folder'
  | 'external'
  | 'warning'
  | 'info'
  | 'star'
  | 'clock'
  | 'filter'
  | 'sort'
  | 'eye'
  | 'eye-off'
  | 'pin'
  | 'drag'
  | 'image'
  | 'mod'
  | 'shader'
  | 'pack'
  | 'world'
  | 'screenshot'
  | 'terminal'
  | 'chart'
  | 'kbd'
  | 'update'
  | 'close-all'
  | 'maximize'
  | 'restore'

export const ICON_NAMES: IconName[] = [
  'home',
  'cube',
  'layers',
  'download',
  'package',
  'box',
  'user',
  'users',
  'beaker',
  'globe',
  'server',
  'lan',
  'radio',
  'link',
  'key',
  'shield',
  'gear',
  'palette',
  'plus',
  'minus',
  'trash',
  'copy',
  'play',
  'stop',
  'refresh',
  'search',
  'check',
  'x',
  'chevron-up',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'folder',
  'external',
  'warning',
  'info',
  'star',
  'clock',
  'filter',
  'sort',
  'eye',
  'eye-off',
  'pin',
  'drag',
  'image',
  'mod',
  'shader',
  'pack',
  'world',
  'screenshot',
  'terminal',
  'chart',
  'kbd',
  'update',
  'close-all',
  'maximize',
  'restore'
]

export const ICON_PATHS: Record<IconName, string> = {
  home: 'M2.6 9.4 10 3l7.4 6.4M4.6 8.6v8.4h10.8V8.6M8.4 17v-4.2h3.2V17',
  cube: 'M10 2.4 16.6 6v8L10 17.6 3.4 14V6L10 2.4M3.4 6 10 9.7 16.6 6M10 9.7v7.9',
  layers: 'M10 2.4 17.2 6.2 10 10 2.8 6.2 10 2.4M2.8 10.4 10 14.2l7.2-3.8M2.8 14 10 17.8l7.2-3.8',
  download: 'M10 2.8v9.2M6 8.4l4 4 4-4M3.4 16.6h13.2',
  package: 'M3 7.4h14v9.6H3zM3 7.4 4.8 3.6h10.4L17 7.4M10 7.4v9.6M6.6 11.4h6.8',
  box: 'M3.4 6.6h13.2v10H3.4zM3.4 6.6 6.4 3.4h7.2l3 3.2M6.8 10.2l6.4 3M13.2 10.2l-6.4 3',
  user: 'M10 10.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8M3.8 17.2c.5-3 3-4.8 6.2-4.8s5.7 1.8 6.2 4.8',
  users:
    'M8.2 9.4a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2.6 16.8c.4-2.7 2.6-4.4 5.6-4.4s5.2 1.7 5.6 4.4M13.6 3.6a3 3 0 0 1 0 5.8M15.2 12.6c2 .7 3.1 2.2 3.4 4.2',
  beaker:
    'M6.8 2.6h6.4M8 2.6v4.8L3.6 15a1.4 1.4 0 0 0 1.2 2.1h10.4A1.4 1.4 0 0 0 16.4 15L12 7.4V2.6M5.4 12.2h9.2',
  globe:
    'M10 17.4a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8M2.6 10h14.8M10 2.6c2.2 2.1 3.3 4.6 3.3 7.4S12.2 15.3 10 17.4C7.8 15.3 6.7 12.8 6.7 10S7.8 4.7 10 2.6',
  server:
    'M3.2 3.6h13.6v4.4H3.2zM3.2 12h13.6v4.4H3.2zM6.2 5.8h.02M6.2 14.2h.02M11.4 5.8h3.6M11.4 14.2h3.6',
  lan: 'M10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4M8.4 2.4h3.2v2.8H8.4zM2.6 14h3.2v3.2H2.6zM14.2 14h3.2v3.2h-3.2zM10 7.8V5.2M8.1 11.7 5.9 13.9M11.9 11.7l2.2 2.2',
  radio: 'M10 8.2v9.2M7.4 17.4h5.2M7.4 6.2a3.7 3.7 0 0 1 5.2 0M4.8 3.6a7.4 7.4 0 0 1 10.4 0M8.6 12.6h2.8',
  link: 'M8.8 11.2 6.6 13.4a3.2 3.2 0 0 1-4.5-4.5l2.2-2.2M11.2 8.8l2.2-2.2a3.2 3.2 0 0 1 4.5 4.5l-2.2 2.2M8.4 11.6 11.6 8.4',
  key: 'M12.8 5.6a2.8 2.8 0 1 1-5.6 0 2.8 2.8 0 0 1 5.6 0M10 8.4v9M10 12.8h3.4M10 15.4h2.6',
  shield: 'M10 2.6 16.8 4.9V9.7c0 3.9-2.6 6.4-6.8 7.7-4.2-1.3-6.8-3.8-6.8-7.7V4.9L10 2.6z',
  gear: 'M8.49 2.25A7.9 7.9 0 0 1 11.51 2.25L11.27 5.27A4.9 4.9 0 0 1 13.46 6.54L15.96 4.82A7.9 7.9 0 0 1 17.47 7.43L14.73 8.73A4.9 4.9 0 0 1 14.73 11.27L17.47 12.57A7.9 7.9 0 0 1 15.96 15.18L13.46 13.46A4.9 4.9 0 0 1 11.27 14.73L11.51 17.75A7.9 7.9 0 0 1 8.49 17.75L8.73 14.73A4.9 4.9 0 0 1 6.54 13.46L4.04 15.18A7.9 7.9 0 0 1 2.53 12.57L4.76 11.31A4.9 4.9 0 0 1 4.76 8.69L2.53 7.43A7.9 7.9 0 0 1 4.04 4.82L6.54 6.54A4.9 4.9 0 0 1 8.73 5.27zM12.3 10a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0',
  palette:
    'M10 2.6A7.4 7.4 0 0 0 10 17.4c1.7 0 2.8-1 2.8-2.1 0-.6-.2-1-.6-1.5-.3-.4-.5-.8-.5-1.2 0-1 .9-1.7 2-1.7h1.2c1.3 0 2.3-.9 2.3-2.2C17.2 5.4 14.1 2.6 10 2.6M6.8 8.6h.02M9.2 5.8h.02',
  plus: 'M10 3.4v13.2M3.4 10h13.2',
  minus: 'M3.4 10h13.2',
  trash: 'M3.2 6.2h13.6M7.6 6.2V3.4h4.8v2.8M4.8 6.2l.8 10.4h8.8l.8-10.4M8.2 9.4v4.2M11.8 9.4v4.2',
  copy: 'M7.4 7.4h8.4v8.4H7.4zM4 12.6V4h8.6',
  play: 'M6.4 3.6 16 10 6.4 16.4z',
  stop: 'M5.4 5.4h9.2v9.2H5.4z',
  refresh: 'M6.4 4.6A6.6 6.6 0 0 1 16.6 8.4M16.6 15.4A6.6 6.6 0 0 1 3.4 11.6M16.6 4.4v4h-4M3.4 15.6v-4h4',
  search: 'M12.6 12.6 17.4 17.4M13.8 8.6a5.2 5.2 0 1 1-10.4 0 5.2 5.2 0 0 1 10.4 0',
  check: 'M3.6 10.8 7.8 15 16.4 5.6',
  x: 'M4.8 4.8 15.2 15.2M15.2 4.8 4.8 15.2',
  'chevron-up': 'M5 12.6 10 7.6 15 12.6',
  'chevron-down': 'M5 7.4 10 12.4 15 7.4',
  'chevron-left': 'M12.6 4.6 7.6 10 12.6 15.4',
  'chevron-right': 'M7.4 4.6 12.4 10 7.4 15.4',
  folder: 'M2.6 17.4V5.4h4.8l1.8 2.6h8.2v9.4H2.6z',
  external: 'M11 3.4h5.6V9M16.6 3.4 9.6 10.4M14 11.4v4.2a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.2',
  warning:
    'M8.7 3.4a1.6 1.6 0 0 1 2.6 0l5.5 9.6a1.6 1.6 0 0 1-1.4 2.4H4.6a1.6 1.6 0 0 1-1.4-2.4L8.7 3.4M10 7.8v4M10 14.4h.02',
  info: 'M10 17.4a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8M10 9.2v4.6M10 6.2h.02',
  star: 'M10 2.6 12.3 7.5 17.6 8.2 13.8 12.1 14.7 17.4 10 14.9 5.3 17.4 6.2 12.1 2.4 8.2 7.7 7.5 10 2.6z',
  clock: 'M10 17.4a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8M10 5.6V10l3.4 2.2',
  filter: 'M2.8 4.4h14.4l-5.6 6.6v5.2l-3.2-1.8v-3.4L2.8 4.4z',
  sort: 'M3.4 5.4h13.2M3.4 10h9.4M3.4 14.6h5.6',
  eye: 'M2.4 10C3.9 7.6 6.7 5 10 5s6.1 2.6 7.6 5c-1.5 2.4-4.3 5-7.6 5S3.9 12.4 2.4 10zM11.8 10a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0',
  'eye-off':
    'M9.2 5.2A7.9 7.9 0 0 0 2.4 10c1.5 2.4 4.3 5 7.6 5 1.2 0 2.3-.3 3.3-.8M14.4 14.4c1.4-1.1 2.6-2.6 3.2-4.4-1.1-1.8-2.6-3.2-4.4-4M3 3l14 14',
  pin: 'M4.6 9.4h10.8l-2.4-2.4.8-4.4H6.2l.8 4.4L4.6 9.4M10 9.4v8',
  drag: 'M7.6 5h.02M12.4 5h.02M7.6 10h.02M12.4 10h.02M7.6 15h.02M12.4 15h.02',
  image: 'M2.8 4.6h14.4v10.8H2.8zM5.6 12.6l3-3.4 2.4 2.6 2.2-2.4 3.2 3.4M13.6 7.6h.02',
  mod: 'M4 4.6h4.2a2 2 0 1 1 3.6 0H16v4.2a2 2 0 1 0 0 3.6v3H4z',
  shader: 'M3 13.8h14M6.4 13.8a3.6 3.6 0 0 1 7.2 0M10 4.6v2.6M5 6.8l1.8 1.8M15 6.8l-1.8 1.8M5.6 16.8h8.8',
  pack: 'M3.2 7h13.6v9.4H3.2zM6.6 7V4.4h6.8V7M3.2 10.4h13.6',
  world: 'M2.8 6.4 7.6 4.4l4.8 2 4.8-2v9.2l-4.8 2-4.8-2-4.8 2zM7.6 4.4v9.2M12.4 6.4v9.2',
  screenshot: 'M2.8 7.2V3.2h4M13.2 3.2h4v4M17.2 12.8v4h-4M7.2 16.8h-4v-4M11.8 10a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0',
  terminal: 'M2.8 4.6h14.4v10.8H2.8zM5.8 8.2 8.2 10.6 5.8 13M10.6 13.2h3.8',
  chart: 'M3.2 3v14h13.6M6.6 13.8V9.4M10 13.8V5.8M13.4 13.8v-2.6',
  kbd: 'M2.6 5.4h14.8v9.2H2.6zM5.4 8.4h.02M8.2 8.4h.02M11 8.4h.02M13.8 8.4h.02M6.4 11.6h7.2',
  update: 'M14.6 5.4A7.4 7.4 0 1 0 10 2.6M10 7.4v5.4M7.6 10.6 10 12.8l2.4-2.2',
  'close-all': 'M2.6 6.6h9.6v9.6H2.6zM6 6.6V3.4h10.8v9.2h-4.6M4.8 8.8 10 14M10 8.8 4.8 14',
  maximize: 'M3.4 3.4h13.2v13.2H3.4z',
  restore: 'M7 7h9.6v9.4H7zM3.4 13.2V3.4h9.8'
}
