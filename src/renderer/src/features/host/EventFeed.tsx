// The item feed: joins, items sent, goals and chat, one colored line each, newest at the bottom.
import type { TFunction } from 'i18next'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { GoatError } from '@shared/errors'
import type { ServerEvent } from '@shared/types'
import { Terminal, type TerminalLine, type TerminalTone } from '../../design/components'
import { describeError } from '../../lib/errors'
import { chatMessage, SERVER_SPEAKER } from './live-state'

const KEY = 'screens.host.feed'

/** One event in words, with its color. Fields the parser could not read fall back to the raw line. */
function describeEvent(event: ServerEvent, t: TFunction): TerminalLine {
  const { player, receiver, item, location } = event
  switch (event.kind) {
    case 'join':
      if (player) return { text: t(`${KEY}.join`, { player }), tone: 'ok' }
      break
    case 'leave':
      if (player) return { text: t(`${KEY}.leave`, { player }), tone: 'dim' }
      break
    case 'item':
      if (player && receiver && item) {
        const sent =
          player === receiver
            ? t(`${KEY}.itemSelf`, { player, item })
            : t(`${KEY}.item`, { player, item, receiver })
        // AP's item colors (progression, useful, trap, filler) need the item class, which the
        // server log does not print: the line keeps the plain tone.
        return { text: location ? `${sent} (${location})` : sent, tone: 'default' }
      }
      break
    case 'goal':
      if (player) return { text: t(`${KEY}.goal`, { player }), tone: 'warn' }
      break
    case 'all-goals':
      return { text: t(`${KEY}.allGoals`), tone: 'warn' }
    case 'chat':
      if (player) {
        const tone: TerminalTone = player === SERVER_SPEAKER ? 'self' : 'info'
        return { text: t(`${KEY}.chat`, { player, message: chatMessage(event) }), tone }
      }
      break
    case 'output':
      break
  }
  return { text: event.text, tone: 'dim' }
}

export interface EventFeedProps {
  /** undefined while the history loads. */
  events: readonly ServerEvent[] | undefined
  error?: GoatError | null
  className?: string
}

export function EventFeed({ events, error, className }: EventFeedProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const lines = useMemo((): TerminalLine[] => {
    if (events === undefined) {
      return error
        ? [{ text: t(`${KEY}.historyError`, { error: describeError(error, t).title }), tone: 'warn' }]
        : [{ text: t(`${KEY}.loading`), tone: 'dim' }]
    }
    // Plain output lines belong to the console.
    const shown = events.filter((event) => event.kind !== 'output')
    if (shown.length === 0) return [{ text: t(`${KEY}.empty`), tone: 'dim' }]
    const clock = new Intl.DateTimeFormat(i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    return shown.map((event) => {
      const line = describeEvent(event, t)
      const at = new Date(event.ts)
      return Number.isNaN(at.getTime()) ? line : { ...line, text: `[${clock.format(at)}] ${line.text}` }
    })
  }, [events, error, t, i18n.language])

  return <Terminal label={t(`${KEY}.title`)} lines={lines} className={className} />
}
