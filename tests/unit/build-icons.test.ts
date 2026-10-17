// The icons electron-builder packs (build/, written by `npm run icons` from build/icon.svg): a 512 px
// PNG, the Linux set build/icons/<n>x<n>.png, and a Windows .ico holding every size from 16 to 256 px.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const build = (path: string): string => fileURLToPath(new URL(`../../build/${path}`, import.meta.url))

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width and height from the IHDR chunk, which always comes first. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  expect(bytes.toString('latin1', 12, 16)).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * The sizes of an .ico's images, from its directory (a 0 byte means 256). Each image is checked to be
 * that size: a PNG, or a 32-bit bitmap whose header doubles the height (the AND mask follows the colors).
 */
function icoSizes(bytes: Buffer): number[] {
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16
    const width = bytes.readUInt8(entry) || 256
    const height = bytes.readUInt8(entry + 1) || 256
    expect(height).toBe(width)
    const image = bytes.subarray(bytes.readUInt32LE(entry + 12)).subarray(0, bytes.readUInt32LE(entry + 8))
    if (image.subarray(0, 8).equals(PNG_SIGNATURE)) {
      expect(pngSize(image)).toEqual({ width, height })
    } else {
      expect(image.readUInt32LE(0)).toBe(40)
      expect([image.readInt32LE(4), image.readInt32LE(8), image.readUInt16LE(14)]).toEqual([
        width,
        height * 2,
        32,
      ])
      expect(image.length).toBe(40 + width * height * 4 + Math.ceil(width / 32) * 4 * height)
    }
    return width
  })
}

describe('build icons', () => {
  it('draws the logo as an SVG of pixels: the goat in violet and yellow, its islands', () => {
    const svg = readFileSync(build('icon.svg'), 'utf8')
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg.toLowerCase()).toContain('#a855f7')
    expect(svg.toLowerCase()).toContain('#facc15')
    expect(svg).toContain('id="goat"')
    expect(svg).toContain('id="islands"')
  })

  it('has a 512 px PNG', () => {
    expect(pngSize(readFileSync(build('icon.png')))).toEqual({ width: 512, height: 512 })
  })

  it('has the Linux sizes, each file the size its name says', () => {
    const names = readdirSync(build('icons')).sort((a, b) => parseInt(a) - parseInt(b))
    expect(names).toEqual([16, 24, 32, 48, 64, 128, 256, 512].map((size) => `${size}x${size}.png`))
    for (const name of names) {
      const size = parseInt(name)
      expect(pngSize(readFileSync(build(`icons/${name}`)))).toEqual({ width: size, height: size })
    }
  })

  it('has a Windows icon with every size from 16 to 256 px', () => {
    expect(existsSync(build('icon.ico'))).toBe(true)
    expect(icoSizes(readFileSync(build('icon.ico'))).sort((a, b) => a - b)).toEqual([
      16, 24, 32, 48, 64, 128, 256,
    ])
  })
})
