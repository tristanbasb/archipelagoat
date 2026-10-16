import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react'
import { cx } from '../classes'
import { sfx, type SfxName } from '../sfx'
import { Spinner } from './Spinner'
import './NeonButton.css'

export type NeonButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type NeonButtonSize = 'sm' | 'md' | 'lg'

export interface NeonButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  variant?: NeonButtonVariant
  size?: NeonButtonSize
  icon?: ReactNode
  /** Disables the button and shows a spinner with `loadingLabel` (or the usual label). */
  loading?: boolean
  loadingLabel?: ReactNode
  /** Press Start 2P label, for the few arcade calls to action (INSERT COIN, JOUER). */
  arcade?: boolean
  /** Sound played on click when sounds are on; false for none. */
  sound?: SfxName | false
  children?: ReactNode
}

const VARIANT_TONE: Record<NeonButtonVariant, string> = {
  primary: 'tone-violet',
  secondary: 'tone-cyan',
  ghost: 'tone-neutral',
  danger: 'tone-pink',
}

export function NeonButton({
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  loadingLabel,
  arcade = false,
  sound,
  children,
  className,
  disabled,
  type = 'button',
  onClick,
  ...rest
}: NeonButtonProps): React.JSX.Element {
  const clickSound = sound ?? (variant === 'primary' ? 'confirm' : 'blip')
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (clickSound) sfx.play(clickSound)
    onClick?.(event)
  }
  const label = loading && loadingLabel !== undefined ? loadingLabel : children
  return (
    <button
      {...rest}
      type={type}
      className={cx('neon-btn pixel-border', VARIANT_TONE[variant], arcade && 'neon-btn--arcade', className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} />
      ) : (
        icon !== undefined && (
          <span className="neon-btn__icon" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      {label !== undefined && label !== null && <span className="neon-btn__label">{label}</span>}
    </button>
  )
}
