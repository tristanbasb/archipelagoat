// Archipelago releases on GitHub (spec 3.2). The release is chosen by `/releases/latest` and its
// `tag_name`, never by a file name: the Windows RC is `Setup.Archipelago.0.6.8-RC1.exe` and the Linux
// RC assets reuse the final names. Assets are chosen by pattern, never by position.
import { z } from 'zod'
import { AP_REPO, ASSET_PATTERNS } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { ApRelease, ReleaseAsset } from '@shared/types'
import type { Http } from '../context'

const API = 'https://api.github.com'

/** How long `fetchLatestApRelease` answers from memory without asking GitHub again. */
const FRESH_MS = 10 * 60 * 1000

const assetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string(),
  size: z.number().int().nonnegative(),
  /** `sha256:<hex>`, GitHub's own digest of the file. */
  digest: z.string().nullish(),
})

const releaseSchema = z.object({
  tag_name: z.string().min(1),
  published_at: z.string().nullish(),
  body: z.string().nullish(),
  assets: z.array(z.unknown()),
})

const releaseAssetsSchema = releaseSchema.pick({ assets: true })

const DIGEST = /^sha256:([0-9a-f]{64})$/i

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** The asset, or null when it is malformed or is not served over https. */
function parseAsset(raw: unknown): ReleaseAsset | null {
  const parsed = assetSchema.safeParse(raw)
  if (!parsed.success || !isHttps(parsed.data.browser_download_url)) return null
  const { name, browser_download_url: url, size, digest } = parsed.data
  return { name, url, size, sha256: DIGEST.exec(digest ?? '')?.[1]?.toLowerCase() ?? null }
}

const parseAssets = (raw: unknown[]): ReleaseAsset[] =>
  raw.map(parseAsset).filter((asset): asset is ReleaseAsset => asset !== null)

/**
 * A GitHub release object as an `ApRelease`. Pure. The version is the tag without a leading `v`;
 * `sha256` is the `digest` of the asset, null when there is none. Throws `INVALID_INPUT` when the
 * object is not a release.
 */
export function parseRelease(json: unknown): ApRelease {
  const parsed = releaseSchema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'not a GitHub release', cause: parsed.error })
  }
  const { tag_name: tag, published_at: publishedAt, body, assets } = parsed.data
  const known = parseAssets(assets)
  const pick = (pattern: RegExp): ReleaseAsset | null =>
    known.find((asset) => pattern.test(asset.name)) ?? null
  return {
    tag,
    version: tag.replace(/^v(?=\d)/i, ''),
    publishedAt: publishedAt ?? '',
    notes: body ?? '',
    windows: pick(ASSET_PATTERNS.windows),
    linuxTarGz: pick(ASSET_PATTERNS.linuxTarGz),
    appImage: pick(ASSET_PATTERNS.appImage),
  }
}

/** GitHub answered 200 with something that is not what its API documents. */
function unexpectedAnswer<T>(url: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_INPUT') {
      throw new AppError('HTTP_ERROR', { status: 200, url }, { detail: error.detail, cause: error })
    }
    throw error
  }
}

const latest = new WeakMap<Http, { at: number; release: ApRelease }>()

/**
 * The latest stable release of Archipelago (`/releases/latest`: no prerelease). The answer is kept in
 * memory for ten minutes, so that screens asking one after the other cost one request; `force` asks
 * again. An answer that GitHub confirmed (a 200, or a 304 on the ETag of the disk cache) is kept and
 * restarts the ten minutes; one that Http served from its disk cache because the network failed
 * (`stale`) is not, so that the next call tries the network again.
 */
export async function fetchLatestApRelease(http: Http, opts: { force?: boolean } = {}): Promise<ApRelease> {
  const kept = latest.get(http)
  if (!opts.force && kept && Date.now() - kept.at < FRESH_MS) return kept.release

  const url = `${API}/repos/${AP_REPO}/releases/latest`
  const { data, stale } = await http.getJson<unknown>(url)
  const release = unexpectedAnswer(url, () => parseRelease(data))
  if (!stale) latest.set(http, { at: Date.now(), release })
  return release
}

const REPO = /^[\w.-]+\/[\w.-]+$/

/**
 * Every asset of the release of `tag` in `repo` (`owner/name`), for repositories whose releases the
 * app pins to a tag (BizHawk). The caller picks the one it wants by name.
 */
export async function fetchReleaseByTag(
  http: Http,
  repo: string,
  tag: string,
): Promise<{ assets: ReleaseAsset[] }> {
  // `.` and `..` would be resolved out of the path by the URL parser.
  if (!REPO.test(repo) || repo.split('/').some((part) => part === '.' || part === '..') || tag === '') {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'repository or tag' })
  }
  const url = `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const { data } = await http.getJson<unknown>(url)
  return unexpectedAnswer(url, () => {
    const parsed = releaseAssetsSchema.safeParse(data)
    if (!parsed.success) throw new AppError('INVALID_INPUT', undefined, { detail: 'release without assets' })
    return { assets: parseAssets(parsed.data.assets) }
  })
}
