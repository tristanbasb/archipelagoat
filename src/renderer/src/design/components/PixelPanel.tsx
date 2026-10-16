import { useId, type HTMLAttributes, type ReactNode } from 'react'
import { cssVars, cx, toneClass, type Tone } from '../classes'
import './PixelPanel.css'

export interface PixelPanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'section' | 'div' | 'article' | 'aside'
  tone?: Tone
  /** Heading of the panel; it also names the region. */
  title?: ReactNode
  /** Small arcade label above the title (Press Start 2P). */
  eyebrow?: ReactNode
  /** Buttons shown at the right of the header. */
  actions?: ReactNode
  glow?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** Types the title in, one character at a time (string titles only). */
  typewriter?: boolean
  headingLevel?: 2 | 3 | 4
}

export function PixelPanel({
  as: Tag = 'section',
  tone = 'neutral',
  title,
  eyebrow,
  actions,
  glow = false,
  padding = 'md',
  typewriter = false,
  headingLevel = 2,
  className,
  children,
  ...rest
}: PixelPanelProps): React.JSX.Element {
  const titleId = useId()
  const Heading = `h${headingLevel}` as const
  const hasHeader = title !== undefined || eyebrow !== undefined || actions !== undefined
  // A section, article or aside named by its title is a region; a plain div cannot be named.
  const named = title !== undefined && Tag !== 'div'
  return (
    <Tag
      {...rest}
      className={cx('pixel-panel pixel-border', toneClass(tone), glow && 'pixel-panel--glow', className)}
      data-padding={padding}
      aria-labelledby={named ? titleId : undefined}
    >
      {hasHeader && (
        <header className="pixel-panel__head">
          <div className="pixel-panel__heading">
            {eyebrow !== undefined && <span className="pixel-panel__eyebrow t-display">{eyebrow}</span>}
            {title !== undefined && (
              <Heading id={titleId} className="pixel-panel__title">
                {typewriter && typeof title === 'string' ? (
                  <span className="typewriter" style={cssVars({ '--chars': title.length })}>
                    {title}
                  </span>
                ) : (
                  title
                )}
              </Heading>
            )}
          </div>
          {actions !== undefined && <div className="pixel-panel__actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="pixel-panel__body">{children}</div>}
    </Tag>
  )
}
