// The live YAML, read-only, coloured in neon: what the file will hold, as the main process writes it.
// The lines of the option being edited light up and scroll into view.
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GoatError } from '@shared/errors'
import { NeonButton, PixelPanel } from '../../design/components'
import { sfx } from '../../design/sfx'
import { describeError } from '../../lib/errors'
import { highlightYaml, type YamlToken } from './yaml-highlight'
import './YamlPreview.css'

export interface YamlPreviewProps {
  /** The rendered YAML; undefined before the first render. */
  text: string | undefined
  pending: boolean
  error: GoatError | null
  /** The game section's name, to find an option's lines. */
  game: string
  /** The option being edited. */
  activeKey: string | null
}

const COPIED_FOR_MS = 1600

const unquote = (key: string): string =>
  /^(["']).*\1$/.test(key) ? key.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"') : key

const indentOf = (tokens: YamlToken[]): number =>
  tokens[0]?.kind === 'plain' && tokens.length > 1 ? tokens[0].text.length : 0

const keyOf = (tokens: YamlToken[]): string | null => {
  const key = tokens.find((token) => token.kind === 'key')
  return key ? unquote(key.text) : null
}

/** The lines `[start, end)` of an option of the game section; null when it is not there. */
export function optionLines(lines: YamlToken[][], game: string, key: string): [number, number] | null {
  const section = lines.findIndex((tokens) => indentOf(tokens) === 0 && keyOf(tokens) === game)
  if (section === -1) return null
  for (let at = section + 1; at < lines.length; at++) {
    const tokens = lines[at] ?? []
    if (tokens.length === 0) continue
    const indent = indentOf(tokens)
    if (indent === 0 && tokens[0]?.kind !== 'comment') return null
    if (indent === 2 && keyOf(tokens) === key) {
      let end = at + 1
      while (end < lines.length) {
        const next = lines[end] ?? []
        if (next.length > 0 && indentOf(next) <= 2 && next[0]?.kind !== 'comment') break
        end++
      }
      return [at, end]
    }
  }
  return null
}

export function YamlPreview({ text, pending, error, game, activeKey }: YamlPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const codeRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const lines = useMemo(() => (text === undefined ? [] : highlightYaml(text.replace(/\n$/, ''))), [text])
  const active = useMemo(
    () => (activeKey === null ? null : optionLines(lines, game, activeKey)),
    [lines, game, activeKey],
  )
  const activeStart = active?.[0] ?? null

  // Bring the option being edited into view, inside the code box only.
  useEffect(() => {
    const box = codeRef.current
    if (!box || activeStart === null) return
    const line = box.querySelector<HTMLElement>(`[data-line="${activeStart}"]`)
    if (!line) return
    const top = line.offsetTop - box.clientHeight / 3
    box.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' })
  }, [activeStart])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    if (text === undefined) return
    navigator.clipboard.writeText(text).then(
      () => {
        sfx.play('coin')
        setCopied(true)
      },
      () => sfx.play('error'),
    )
  }

  const failure = error ? describeError(error, t) : null

  return (
    <PixelPanel
      tone="cyan"
      padding="none"
      eyebrow={
        <span className="yaml-preview__live" data-pending={pending || undefined}>
          {t('screens.studio.preview.eyebrow')}
        </span>
      }
      title={t('screens.studio.preview.title')}
      className="yaml-preview"
      actions={
        <NeonButton
          variant="ghost"
          size="sm"
          sound={false}
          disabled={text === undefined}
          aria-label={t('screens.studio.preview.copyLabel')}
          icon={copied ? <IconCheck /> : <IconCopy />}
          onClick={copy}
        >
          {copied ? t('screens.studio.preview.copied') : t('screens.studio.preview.copy')}
        </NeonButton>
      }
    >
      {pending && <span className="sr-only">{t('screens.studio.preview.pending')}</span>}
      {failure && (
        <p className="yaml-preview__error" role="alert">
          {t('screens.studio.preview.error')} · {failure.title}
        </p>
      )}
      {text === undefined ? (
        <p className="yaml-preview__empty">{t('screens.studio.preview.empty')}</p>
      ) : (
        <pre
          ref={codeRef}
          className="yaml-code"
          tabIndex={0}
          aria-label={t('screens.studio.preview.title')}
          data-pending={pending || undefined}
        >
          <code>
            {lines.map((tokens, index) => (
              <span
                key={index}
                className="yaml-code__line"
                data-line={index}
                data-active={(active !== null && index >= active[0] && index < active[1]) || undefined}
              >
                {tokens.map((token, at) => (
                  <span key={at} className={`yt yt--${token.kind}`}>
                    {token.text}
                  </span>
                ))}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}
    </PixelPanel>
  )
}
