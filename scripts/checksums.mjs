// Writes SHA256SUMS.txt next to the artifacts of a release folder, in the format of `sha256sum`
// (check them with `sha256sum -c SHA256SUMS.txt`, or Get-FileHash on Windows).
// Usage: node scripts/checksums.mjs [folder]   (default: release/<version of package.json>)
//
// The artifacts are the installers and archives: .exe, .AppImage, .deb, .tar.gz. What electron-builder
// leaves next to them (update metadata, block maps, its logs, the unpacked apps, the uninstaller it
// embeds in the setup) is not one.
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ARTIFACT = /\.(?:exe|AppImage|deb|tar\.gz)$/
const SUMS = 'SHA256SUMS.txt'

function defaultFolder() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  return fileURLToPath(new URL(`../release/${pkg.version}`, import.meta.url))
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const folder = process.argv[2] ?? defaultFolder()

let files
try {
  files = readdirSync(folder, { withFileTypes: true })
} catch (error) {
  console.error(`checksums: cannot read ${folder}: ${error.message}`)
  process.exit(1)
}

const names = files
  .filter((entry) => entry.isFile() && ARTIFACT.test(entry.name) && !entry.name.startsWith('__'))
  .map((entry) => entry.name)
  .sort()
if (names.length === 0) {
  console.error(`checksums: no artifact in ${folder}`)
  process.exit(1)
}

const lines = []
for (const name of names) lines.push(`${await sha256(join(folder, name))}  ${name}`)
writeFileSync(join(folder, SUMS), `${lines.join('\n')}\n`)
console.log(`checksums: ${names.length} artifacts in ${join(folder, SUMS)}`)
for (const line of lines) console.log(`  ${line}`)
