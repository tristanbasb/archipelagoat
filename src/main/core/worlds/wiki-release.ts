// The release of a world only the wiki lists (spec §3.9): its page links to the latest GitHub release
// of a repository, asked when the world is installed and never in advance (anonymous GitHub allows
// 60 requests an hour, and the catalog lists hundreds of such worlds). The APWorld is picked among
// the assets by name, its digest kept as the sha256 the download is checked against.
import { AppError } from '@shared/errors'
import type { ReleaseAsset } from '@shared/types'
import {
  GITHUB_API,
  isRepoName,
  parseAssets,
  releaseSchema,
  unexpectedAnswer,
  versionOfTag,
} from '../ap/releases'
import type { Http } from '../context'
import { compactKey } from './catalog'

export interface WikiRelease {
  /** The tag, without a leading `v`. */
  version: string
  url: string
  /** GitHub's digest of the asset; null when it has none. */
  sha256: string | null
}

/** `resolveWikiRelease` with its Http bound. */
export type WikiReleaseResolver = (repo: string, game: string, pageUrl: string) => Promise<WikiRelease>

const latestSchema = releaseSchema.pick({ tag_name: true, assets: true })

const APWORLD = /\.apworld$/i

/** The APWorld of the release: the only one, else the only one named after the game. */
function pickApworld(assets: readonly ReleaseAsset[], game: string): ReleaseAsset | 'none' | 'ambiguous' {
  const apworlds = assets.filter((asset) => APWORLD.test(asset.name))
  if (apworlds.length === 0) return 'none'
  // A repository may hold several games (a fork of Archipelago): the file name tells them apart.
  const matches =
    apworlds.length === 1
      ? apworlds
      : apworlds.filter((asset) => compactKey(asset.name.replace(APWORLD, '')) === compactKey(game))
  const [only] = matches
  return matches.length === 1 && only ? only : 'ambiguous'
}

/**
 * The APWorld of the latest stable release of `repo` (`owner/name`) for `game`. Throws
 * `WORLD_RELEASE_UNAVAILABLE` with `pageUrl`, the page the user can download it from by hand, when
 * GitHub has no stable release (`no-release`), when the release has no .apworld (`no-apworld`), or
 * when several .apworld files may be that game's (`ambiguous`). Rate limits and network failures
 * pass through as Http maps them.
 */
export async function resolveWikiRelease(
  http: Http,
  repo: string,
  game: string,
  pageUrl: string,
): Promise<WikiRelease> {
  if (!isRepoName(repo)) throw new AppError('INVALID_INPUT', undefined, { detail: 'repository' })
  const unavailable = (reason: 'no-release' | 'no-apworld' | 'ambiguous'): AppError =>
    new AppError('WORLD_RELEASE_UNAVAILABLE', { reason, url: pageUrl }, { detail: repo })

  const url = `${GITHUB_API}/repos/${repo}/releases/latest`
  const { data } = await http
    .getJson<unknown>(url, { cacheKey: `wiki-release:${repo.toLowerCase()}` })
    .catch((error: unknown) => {
      // `/releases/latest` is a 404 when the repository has only prereleases, or none at all.
      if (error instanceof AppError && error.code === 'HTTP_ERROR' && error.params?.status === 404) {
        throw unavailable('no-release')
      }
      throw error
    })
  const release = unexpectedAnswer(url, () => {
    const parsed = latestSchema.safeParse(data)
    if (!parsed.success) throw new AppError('INVALID_INPUT', undefined, { detail: 'not a GitHub release' })
    return { version: versionOfTag(parsed.data.tag_name), assets: parseAssets(parsed.data.assets) }
  })
  const asset = pickApworld(release.assets, game)
  if (asset === 'none') throw unavailable('no-apworld')
  if (asset === 'ambiguous') throw unavailable('ambiguous')
  return { version: release.version, url: asset.url, sha256: asset.sha256 }
}
