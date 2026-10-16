import { IconAlertTriangle, IconBook2, IconRosetteDiscountCheck, IconShieldCheck } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { TrustTier } from '@shared/types'
import type { Tone } from '../classes'
import { Badge } from './Badge'
import { Tooltip } from './Tooltip'

const TIERS: Record<TrustTier, { tone: Tone; icon: ReactNode }> = {
  core: { tone: 'green', icon: <IconShieldCheck /> },
  'indexed-verified': { tone: 'cyan', icon: <IconRosetteDiscountCheck /> },
  'wiki-release': { tone: 'yellow', icon: <IconBook2 /> },
  unknown: { tone: 'pink', icon: <IconAlertTriangle /> },
}

export interface TrustBadgeProps {
  tier: TrustTier
  /** The translated name of the tier. */
  label: string
  /** What the tier means, shown in a tooltip. */
  description?: string
  className?: string
}

/** How far an APWorld can be trusted: core, verified index entry, wiki release, or unknown. */
export function TrustBadge({ tier, label, description, className }: TrustBadgeProps): React.JSX.Element {
  const { tone, icon } = TIERS[tier]
  const badge = (
    <span className="trust-badge" data-tier={tier} tabIndex={description !== undefined ? 0 : undefined}>
      <Badge tone={tone} icon={icon} className={className}>
        {label}
      </Badge>
    </span>
  )
  return description !== undefined ? <Tooltip content={description}>{badge}</Tooltip> : badge
}
