// The sites the app opens in the browser (spec §6.1). The main process refuses any other link; the
// renderer asks the same question before it offers to open one, so that no button is refused.

const EXTERNAL_HOSTS = [
  'archipelago.gg',
  'github.com',
  'archipelago.miraheze.org',
  'tasvideos.org',
  'discord.gg',
  'learn.microsoft.com',
]

/** https only, default port, and an allow-listed host or one of its subdomains. */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '') return false
  const host = url.hostname.toLowerCase()
  return EXTERNAL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}
