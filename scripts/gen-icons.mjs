#!/usr/bin/env node
/**
 * Draws the MoucLauncher mark with code (no bitmaps, no AI images) and rasterizes it
 * natively at every target pixel size, then packs a Windows .ico.
 *
 *   node scripts/gen-icons.mjs [--accent=#33C6B4] [--surface=#14161A]
 *
 * Why per-size geometry: a monoline monogram needs a heavier stroke and fewer details
 * at 16px than at 256px, otherwise it turns to mush in the taskbar.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RAW_DIR = path.join(ROOT, 'build', 'raw')
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const ACCENT = arg('accent', '#33C6B4')
const SURFACE = arg('surface', '#14161A')

/* ----------------------------- mark geometry ----------------------------- */

/** Builds the SVG for one exact pixel size. */
function markSvg(size, accent = ACCENT, surface = SURFACE) {
  const s = size
  const radius = Math.max(3, Math.round(s * 0.22))
  // Monoline weight: 11% of the canvas, but never thinner than 1.6px.
  const stroke = Math.max(1.6, s * 0.11)
  const pad = s * (s <= 24 ? 0.24 : 0.26)
  const x0 = pad
  const x1 = s - pad
  const xm = s / 2
  const y0 = pad + s * 0.04
  const y1 = s - pad - s * 0.04
  const vDepth = y0 + (y1 - y0) * (s <= 24 ? 0.72 : 0.62)
  const monogram = `M ${r(x0)} ${r(y1)} L ${r(x0)} ${r(y0)} L ${r(xm)} ${r(vDepth)} L ${r(x1)} ${r(y0)} L ${r(x1)} ${r(y1)}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${r(radius)}" fill="${surface}"/>
  <path d="${monogram}" fill="none" stroke="${accent}" stroke-width="${r(stroke)}" stroke-linecap="square" stroke-linejoin="miter"/>
</svg>`
}

function r(value) {
  return Math.round(value * 1000) / 1000
}

/* ----------------------------- png primitives ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** RGBA (non-premultiplied) -> 8-bit RGB alpha PNG. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function rasterize(svg) {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: sizeOf(svg) } }).render()
  return { width: image.width, height: image.height, rgba: unpremultiply(Buffer.from(image.pixels)) }
}

function sizeOf(svg) {
  const match = /width="(\d+)"/.exec(svg)
  return Number(match ? match[1] : 256)
}

/** resvg returns premultiplied pixels; ICO/PNG entries and the sheet want straight alpha. */
function unpremultiply(rgba) {
  const out = Buffer.alloc(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = 0
      out[i + 3] = 0
      continue
    }
    const scale = 255 / a
    out[i] = Math.min(255, Math.round(rgba[i] * scale))
    out[i + 1] = Math.min(255, Math.round(rgba[i + 1] * scale))
    out[i + 2] = Math.min(255, Math.round(rgba[i + 2] * scale))
    out[i + 3] = a
  }
  return out
}

/* --------------------------------- ico ---------------------------------- */

/** BMP entry: BITMAPINFOHEADER with doubled height, bottom-up BGRA, then a 1-bit AND mask. */
function icoBmpEntry(size, rgba) {
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(size, 4)
  dib.writeInt32LE(size * 2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(32, 14)
  dib.writeUInt32LE(0, 16)
  dib.writeUInt32LE(size * size * 4 + ((Math.ceil(size / 32) * 4) * size), 20)

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const srcRow = y * size * 4
    const dstRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x += 1) {
      const i = srcRow + x * 4
      const o = dstRow + x * 4
      pixels[o] = rgba[i + 2]
      pixels[o + 1] = rgba[i + 1]
      pixels[o + 2] = rgba[i]
      pixels[o + 3] = rgba[i + 3]
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = rgba[(y * size + x) * 4 + 3]
      if (alpha < 128) mask[y * maskRowBytes + (x >> 3)] |= 0x80 >> (x % 8)
    }
  }
  return Buffer.concat([dib, pixels, mask])
}

/** Small sizes as BMP for driver compatibility, 64+ as PNG (the `-icowe` layout). */
function buildIco(images) {
  const entries = images.map(({ size, rgba, png }) => ({
    size,
    data: size < 64 ? icoBmpEntry(size, rgba) : png
  }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = header.length + entries.length * 16
  const directory = Buffer.alloc(entries.length * 16)
  entries.forEach((entry, index) => {
    const at = index * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)])
}

/* -------------------------------- sheet -------------------------------- */

function blit(target, source, targetWidth, offsetX, offsetY, cellBounds) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const px = offsetX + x
      const py = offsetY + y
      // Clip to the cell: an oversized icon must never bleed into its neighbour.
      if (px < cellBounds.x0 || px >= cellBounds.x1 || py < cellBounds.y0 || py >= cellBounds.y1) continue
      const s = (y * source.width + x) * 4
      if (source.rgba[s + 3] === 0) continue
      const d = (py * targetWidth + px) * 4
      for (let c = 0; c < 4; c += 1) target[d + c] = source.rgba[s + c]
    }
  }
}

/** Contact sheet drawn at true pixel sizes, so a 16px cell really is 16px. */
function buildSheet(images, cell, columns, background) {
  const rows = Math.ceil(images.length / columns)
  const width = columns * cell
  const height = rows * cell
  const canvas = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    canvas[i * 4] = background[0]
    canvas[i * 4 + 1] = background[1]
    canvas[i * 4 + 2] = background[2]
    canvas[i * 4 + 3] = 255
  }
  images.forEach((image, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const offsetX = col * cell + Math.floor((cell - image.width) / 2)
    const offsetY = row * cell + Math.floor((cell - image.height) / 2)
    blit(canvas, image, width, offsetX, offsetY, {
      x0: col * cell,
      x1: (col + 1) * cell,
      y0: row * cell,
      y1: (row + 1) * cell
    })
  })
  return { width, height, rgba: canvas }
}

function upscale(source, factor) {
  const width = source.width * factor
  const height = source.height * factor
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (Math.floor(y / factor) * source.width + Math.floor(x / factor)) * 4
      const d = (y * width + x) * 4
      for (let c = 0; c < 4; c += 1) out[d + c] = source.rgba[s + c]
    }
  }
  return { width, height, rgba: out }
}

/* --------------------------------- main -------------------------------- */

fs.mkdirSync(RAW_DIR, { recursive: true })
fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true })

const images = SIZES.map((size) => {
  const svg = markSvg(size)
  fs.writeFileSync(path.join(RAW_DIR, `mark-${size}.svg`), svg, 'utf8')
  const raster = rasterize(svg)
  const png = encodePng(raster.width, raster.height, raster.rgba)
  fs.writeFileSync(path.join(RAW_DIR, `icon-${size}.png`), png)
  return { size, ...raster, png }
})

fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(images))
fs.writeFileSync(path.join(ROOT, 'resources', 'icon.png'), images.find((i) => i.size === 256).png)
fs.writeFileSync(path.join(ROOT, 'resources', 'icon-16.png'), images.find((i) => i.size === 16).png)
fs.writeFileSync(path.join(ROOT, 'resources', 'icon-32.png'), images.find((i) => i.size === 32).png)

const dark = [24, 26, 31]
const light = [236, 238, 240]
const small = images.filter((image) => image.size <= 64)
const large = images.filter((image) => image.size > 64)
const sheets = [
  ['small', small, 72, 6, 5],
  ['large', large, 272, 2, 2]
]
for (const [sheetName, set, cell, columns, factor] of sheets) {
  for (const [backgroundName, background] of [
    ['dark', dark],
    ['light', light]
  ]) {
    const sheet = buildSheet(set, cell, columns, background)
    fs.writeFileSync(
      path.join(ROOT, 'build', `sheet-${sheetName}-${backgroundName}.png`),
      encodePng(sheet.width, sheet.height, sheet.rgba)
    )
    const big = upscale(sheet, factor)
    fs.writeFileSync(
      path.join(ROOT, 'build', `sheet-${sheetName}-${backgroundName}-${factor}x.png`),
      encodePng(big.width, big.height, big.rgba)
    )
  }
}

const icoSize = fs.statSync(path.join(ROOT, 'build', 'icon.ico')).size
console.log(
  `icons: ${images.length} sizes rendered natively [${SIZES.join(', ')}], accent ${ACCENT}, ico ${icoSize} bytes`
)
