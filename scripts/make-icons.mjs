// Renders build/icon.svg into the icons electron-builder packs: build/icon.png (512 px), the Linux set
// build/icons/<n>x<n>.png, and build/icon.ico (16 to 256 px) for Windows.
// Usage: node scripts/make-icons.mjs   (npm run icons)
//
// The logo is pixel art on a 32×32 grid, rendered straight at each size (no resampling) with crisp
// edges. Below 32 px a grid pixel would fall under one screen pixel, so 16 and 24 px show the goat
// alone (its own 16×16 grid, the `goat` group of the SVG).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const build = (path) => fileURLToPath(new URL(`../build/${path}`, import.meta.url))

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const GOAT_ONLY_BELOW = 32

const full = readFileSync(build('icon.svg'), 'utf8')

/** The `goat` group of icon.svg on its own 16×16 grid, without the tile and the islands. */
function goatOnly(svg) {
  const goat = /<g id="goat"[^>]*>([\s\S]*?)<\/g>/.exec(svg)
  if (!goat) throw new Error('make-icons: build/icon.svg has no <g id="goat">')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${goat[1]}</svg>`
}

/** The SVG's width in px (its `width` attribute), so that a density renders it at exactly `size`. */
function widthOf(svg) {
  const width = /<svg[^>]*\swidth="(\d+)"/.exec(svg)
  if (!width) throw new Error('make-icons: an SVG without a width')
  return Number(width[1])
}

/** A PNG of `svg` at `size` × `size`, rasterized at that size (72 dpi is one px per SVG unit of width). */
async function render(svg, size) {
  const density = (72 * size) / widthOf(svg)
  const png = await sharp(Buffer.from(svg), { density })
    .resize(size, size, { kernel: 'nearest' })
    .png()
    .toBuffer()
  const { width, height } = await sharp(png).metadata()
  if (width !== size || height !== size)
    throw new Error(`make-icons: rendered ${width}×${height}, not ${size}`)
  return png
}

const goat = goatOnly(full)
const pngs = new Map()
for (const size of LINUX_SIZES) pngs.set(size, await render(size < GOAT_ONLY_BELOW ? goat : full, size))

mkdirSync(build('icons'), { recursive: true })
for (const [size, png] of pngs) writeFileSync(build(`icons/${size}x${size}.png`), png)
writeFileSync(build('icon.png'), pngs.get(512))
writeFileSync(build('icon.ico'), await pngToIco(ICO_SIZES.map((size) => pngs.get(size))))

console.log(
  `make-icons: build/icon.png (512), build/icons/ (${LINUX_SIZES.join(', ')}), build/icon.ico (${ICO_SIZES.join(', ')})`,
)
