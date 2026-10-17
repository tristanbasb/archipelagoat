// The manifest of a player's patch (spec §3.12, research brief §1.11): a patch container is a zip with
// an `archipelago.json` that names the game, the slot, the server and the base ROM it needs
// (worlds/Files.py, APPlayerContainer.get_manifest and APProcedurePatch.get_manifest). It is read
// without Python, and without extracting anything.
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { PatchManifest } from '@shared/types'
import { readZipText } from '../system/archive'

const MANIFEST_ENTRY = 'archipelago.json'

const Md5 = z.string().transform((md5) => md5.trim().toLowerCase())

const ManifestSchema = z.object({
  game: z.string().min(1),
  player: z.number().int().positive(),
  player_name: z.string(),
  // '' when AP made the patch without a server (a local generation); the site writes `<host>:<port>`.
  server: z.string().nullish(),
  patch_file_ending: z.string().nullish(),
  // One MD5 (APProcedurePatch.hash) or a list of them (worlds/mm2/rom.py:107); None when there is none.
  base_checksum: z.union([Md5, z.array(Md5)]).nullish(),
  result_file_ending: z.string().nullish(),
  compatible_version: z.number().int().nullish(),
  version: z.number().int().nullish(),
})

const invalid = (reason: string, detail: string, cause?: unknown): AppError =>
  new AppError('PATCH_INVALID', { reason }, { detail, cause })

/**
 * The `archipelago.json` of the patch at `path`. PATCH_INVALID (`reason`: `not-zip`, `zip-bomb`,
 * `traversal`, `no-manifest`, `json`, `manifest`) when the file is no patch container or its manifest
 * is missing or not what AP writes; NOT_FOUND when the file does not exist.
 */
export async function readPatchManifest(path: string): Promise<PatchManifest> {
  let text: string | null
  try {
    text = await readZipText(path, MANIFEST_ENTRY)
  } catch (error) {
    // The archive helpers call any unacceptable zip WORLD_INVALID: here it is an invalid patch.
    if (error instanceof AppError && error.code === 'WORLD_INVALID') {
      throw invalid(String(error.params?.reason ?? 'not-zip'), error.detail ?? path, error)
    }
    throw error
  }
  if (text === null) throw invalid('no-manifest', path)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw invalid('json', path, cause)
  }
  const parsed = ManifestSchema.safeParse(json)
  if (!parsed.success) throw invalid('manifest', path)
  const manifest = parsed.data
  const checksums = manifest.base_checksum ?? []
  return {
    game: manifest.game,
    player: manifest.player,
    playerName: manifest.player_name,
    server: manifest.server || null,
    patchFileEnding: manifest.patch_file_ending ?? '',
    baseChecksums: typeof checksums === 'string' ? [checksums] : checksums,
    resultFileEnding: manifest.result_file_ending ?? null,
    compatibleVersion: manifest.compatible_version ?? null,
    version: manifest.version ?? null,
  }
}
