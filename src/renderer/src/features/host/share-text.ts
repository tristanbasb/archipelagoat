// The message the organizer pastes in the group chat: where to connect, the password when they
// choose to share it, and who plays what.
import type { TFunction } from 'i18next'
import type { Address, Session, WebRoom } from '@shared/types'

const KEY = 'screens.host.share'

/** Players reach the server through its LAN or public address; localhost only when there is no other. */
export function sharedAddresses(addresses: readonly Address[]): Address[] {
  const reachable = addresses.filter((address) => address.kind !== 'localhost')
  return reachable.length > 0 ? reachable : [...addresses]
}

function isAddressList(target: readonly Address[] | WebRoom): target is readonly Address[] {
  return Array.isArray(target)
}

/**
 * The share text of a local server (its addresses) or of an archipelago.gg room. The password line
 * is there only when `password` is given (not null, not empty).
 */
export function buildShareText(
  session: Session,
  target: readonly Address[] | WebRoom,
  { password }: { password: string | null },
  t: TFunction,
): string {
  const lines = [t(`${KEY}.heading`, { name: session.name })]
  if (isAddressList(target)) {
    for (const address of sharedAddresses(target)) {
      lines.push(t(`${KEY}.address.${address.kind}`, { address: `${address.host}:${address.port}` }))
    }
  } else {
    // A sleeping room has no port until it is woken up.
    if (target.port !== null) {
      lines.push(t(`${KEY}.address.web`, { address: `${target.host}:${target.port}` }))
    }
    lines.push(t(`${KEY}.room`, { url: target.roomUrl }))
  }
  if (password) lines.push(t(`${KEY}.password`, { password }))
  const slots = session.generation?.slots ?? []
  if (slots.length > 0) {
    lines.push(t(`${KEY}.slots`))
    for (const slot of slots) lines.push(t(`${KEY}.slot`, { name: slot.name, game: slot.game }))
  }
  return lines.join('\n')
}
