// Builds .tar.gz archives for the tests from raw tar headers, so the file modes are exactly the ones
// given (a Windows test host has no executable bit to read), and a small copy of the layout of the
// Linux release of Archipelago 0.6.8 (brief §1.3: one top folder `Archipelago/`).
import { gzipSync } from 'node:zlib'
import { Header } from 'tar'

export interface TarItem {
  path: string
  data?: string
  type?: 'File' | 'Directory'
  mode?: number
}

export function tarGz(items: readonly TarItem[]): Buffer {
  const parts: Buffer[] = []
  for (const item of items) {
    const type = item.type ?? 'File'
    const body = type === 'File' ? Buffer.from(item.data ?? '') : Buffer.alloc(0)
    const block = Buffer.alloc(512)
    new Header({
      path: item.path,
      type,
      mode: item.mode ?? (type === 'Directory' ? 0o755 : 0o644),
      size: body.length,
      mtime: new Date(0),
    }).encode(block, 0)
    parts.push(block)
    if (body.length > 0) parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** The 0.6.8 Linux release, in small: programs at the root, lib/, data/, SNI/ and the shipped templates. */
export const AP_LINUX_RELEASE_ITEMS: readonly TarItem[] = [
  { path: 'Archipelago/', type: 'Directory' },
  { path: 'Archipelago/ArchipelagoLauncher', data: 'launcher 0.6.8', mode: 0o755 },
  { path: 'Archipelago/ArchipelagoGenerate', data: 'generate 0.6.8', mode: 0o755 },
  { path: 'Archipelago/manifest.json', data: JSON.stringify({ version: [0, 6, 8] }) },
  { path: 'Archipelago/LICENSE', data: 'MIT' },
  { path: 'Archipelago/lib/', type: 'Directory' },
  { path: 'Archipelago/lib/libssl.so.3', data: 'ssl 3' },
  { path: 'Archipelago/data/', type: 'Directory' },
  { path: 'Archipelago/data/sprites.txt', data: 'sprites' },
  { path: 'Archipelago/SNI/', type: 'Directory' },
  { path: 'Archipelago/SNI/sni', data: 'sni', mode: 0o755 },
  { path: 'Archipelago/Players/', type: 'Directory' },
  { path: 'Archipelago/Players/Templates/', type: 'Directory' },
  { path: 'Archipelago/Players/Templates/A Link to the Past.yaml', data: 'game: A Link to the Past' },
]
