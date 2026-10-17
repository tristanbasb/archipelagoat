// The launch side of a join plan: the JOUER start button, the connection details with the Text
// Client, and the steps of the assisted and guided tiers.
import { IconBolt, IconExternalLink, IconLock, IconRoute, IconTerminal2 } from '@tabler/icons-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JoinPlan } from '@shared/types'
import { Badge, CopyField, ErrorPanel, NeonButton, PixelPanel, useToast } from '../../design/components'
import { cx, type Tone } from '../../design/classes'
import { sfx } from '../../design/sfx'
import { useIpcMutation } from '../../hooks/useIpc'
import { describeError } from '../../lib/errors'
import { STEP_FOCUS_PANEL } from './step-focus'
import './PlayPanels.css'

/** host:port to connect to (host alone while the room has no port). */
export function connectAddress(plan: JoinPlan): string {
  const { host, port } = plan.connect
  return port === null ? host : `${host}:${port}`
}

/** How much the app does for the player: everything (full), or JOUER plus steps by hand. */
const TIER_BADGE: Record<JoinPlan['route']['tier'], { tone: Tone; icon: React.JSX.Element }> = {
  full: { tone: 'green', icon: <IconBolt /> },
  assisted: { tone: 'cyan', icon: <IconRoute /> },
  guided: { tone: 'yellow', icon: <IconRoute /> },
}

const slotOf = (plan: JoinPlan): string | null => plan.connect.slot ?? plan.slot?.name ?? null

/** The password of an archipelago:// link; a room never hands its password out. */
const passwordOf = (plan: JoinPlan): string | null =>
  plan.target.kind === 'address' ? plan.target.password : null

/** The big arcade start button: lit and pulsing once the plan is ready. */
export function StartPanel({ plan }: { plan: JoinPlan }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const captionId = useId()
  const play = useIpcMutation('join:play')
  const [launchedPlan, setLaunchedPlan] = useState<string | null>(null)
  const client = t(`screens.join.clients.${plan.route.client}`)
  const launched = launchedPlan === plan.planId && !play.isPending
  const failed = play.isError ? describeError(play.error, t) : null

  const start = async (): Promise<void> => {
    sfx.play('coin')
    setLaunchedPlan(null)
    try {
      await play.mutateAsync({ planId: plan.planId })
      setLaunchedPlan(plan.planId)
      sfx.play('success')
      toast.push({
        tone: 'ok',
        title: t('screens.join.start.toast'),
        body: t('screens.join.start.toastBody'),
      })
    } catch {
      sfx.play('error')
    }
  }

  const caption = play.isPending
    ? t('screens.join.start.launching')
    : launched
      ? t('screens.join.start.launched', { client })
      : plan.ready
        ? t('screens.join.start.ready', { client })
        : t('screens.join.start.notReady')

  return (
    <div
      className={cx('start-panel pixel-border', plan.ready ? 'tone-yellow' : 'tone-neutral')}
      data-ready={plan.ready || undefined}
      data-launched={launched || undefined}
    >
      <div className="start-panel__marquee t-display" aria-hidden="true">
        <span className="start-panel__blink">{t('screens.join.start.eyebrow')}</span>
      </div>
      <button
        type="button"
        className="start-button"
        disabled={!plan.ready || play.isPending}
        aria-busy={play.isPending || undefined}
        aria-describedby={captionId}
        onClick={() => void start()}
      >
        <span className="start-button__halo" aria-hidden="true" />
        <span className="start-button__ring" aria-hidden="true" />
        <span className="start-button__bezel" aria-hidden="true" />
        <span className="start-button__side" aria-hidden="true" />
        <span className="start-button__cap">
          <span className="start-button__shine" aria-hidden="true" />
          <span className="start-button__label">{t('screens.join.start.play')}</span>
        </span>
      </button>
      <p id={captionId} className="start-panel__caption" role="status">
        {caption}
      </p>
      <div className="start-panel__foot">
        <Badge tone={TIER_BADGE[plan.route.tier].tone} icon={TIER_BADGE[plan.route.tier].icon}>
          {t(`screens.join.tier.${plan.route.tier}`)}
        </Badge>
        <span className="start-panel__credit t-display" aria-hidden="true">
          {t('screens.join.start.credit', { n: plan.ready ? '01' : '00' })}
        </span>
      </div>
      {failed && (
        <ErrorPanel
          className="start-panel__error"
          title={failed.title}
          body={failed.body}
          detail={failed.detail}
          detailLabel={t('common.technicalDetails')}
        />
      )}
    </div>
  )
}

/** Where to connect: the address, the slot, the link's password, and the Text Client. */
export function ConnectionPanel({
  plan,
  featured,
}: {
  plan: JoinPlan
  /** No client to launch (a PC game): the connection details are what the player needs. */
  featured: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const textClient = useIpcMutation('join:textClient', {
    onSuccess: () => toast.push({ tone: 'ok', title: t('screens.join.connection.textClientStarted') }),
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  const slot = slotOf(plan)
  const password = passwordOf(plan)
  const { host, port } = plan.connect

  const openTextClient = (): void => {
    if (port === null || slot === null) return
    textClient.mutate({ host, port, slot, ...(password ? { password } : {}) })
  }

  return (
    <PixelPanel
      className="connection-panel"
      tone={featured ? 'cyan' : 'neutral'}
      glow={featured}
      eyebrow={t('screens.join.connection.eyebrow')}
      title={t('screens.join.connection.title')}
    >
      {featured && <p className="connection-panel__lead">{t('screens.join.connection.pcGame')}</p>}
      <div className="connection-panel__fields">
        <CopyField
          label={t('screens.join.connection.address')}
          value={connectAddress(plan)}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
        />
        {slot !== null && (
          <CopyField
            label={t('screens.join.connection.slot')}
            value={slot}
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
          />
        )}
        {password && (
          <CopyField
            secret
            label={t('screens.join.connection.passwordField')}
            value={password}
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
            revealLabel={t('screens.join.connection.reveal')}
            hideLabel={t('screens.join.connection.hide')}
          />
        )}
      </div>
      {port === null && <p className="connection-panel__note">{t('screens.join.connection.asleep')}</p>}
      {plan.connect.hasPassword && !password && (
        <Badge tone="yellow" icon={<IconLock />} className="connection-panel__badge">
          {t('screens.join.connection.password')}
        </Badge>
      )}
      <div className="connection-panel__text-client">
        <NeonButton
          variant="secondary"
          icon={<IconTerminal2 />}
          disabled={port === null || slot === null}
          loading={textClient.isPending}
          onClick={openTextClient}
        >
          {t('screens.join.connection.textClient')}
        </NeonButton>
        <span className="connection-panel__hint">{t('screens.join.connection.textClientHint')}</span>
      </div>
    </PixelPanel>
  )
}

const STEP_NUMBERS = ['1', '2', '3', '4'] as const

/** The assisted and guided tiers: what the player does by hand, and the official tutorial. */
export function GuidePanel({ plan }: { plan: JoinPlan }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const openExternal = useIpcMutation('app:openExternal', {
    onError: (error) => {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
    },
  })
  const tier = plan.route.tier === 'guided' ? 'guided' : 'assisted'
  const slot = slotOf(plan)
  const values = {
    client: t(`screens.join.clients.${plan.route.client}`),
    address: connectAddress(plan),
    ...(slot !== null ? { slot } : {}),
  }
  const tutorialUrl = plan.tutorialUrl

  return (
    <PixelPanel
      {...STEP_FOCUS_PANEL}
      className="guide-panel"
      tone="cyan"
      eyebrow={t('screens.join.guide.eyebrow')}
      title={t('screens.join.guide.title')}
      actions={
        <Badge tone={TIER_BADGE[tier].tone} icon={TIER_BADGE[tier].icon}>
          {t(`screens.join.tier.${tier}`)}
        </Badge>
      }
    >
      <ol className="guide-steps">
        {STEP_NUMBERS.map((step) => (
          <li key={step} className="guide-steps__step">
            <span className="guide-steps__number t-display" aria-hidden="true">
              {step}
            </span>
            <span>{t(`screens.join.guide.${tier}.${step}`, values)}</span>
          </li>
        ))}
      </ol>
      {plan.connect.hasPassword && (
        <p className="guide-panel__note">
          <IconLock aria-hidden="true" />
          {t('screens.join.guide.password')}
        </p>
      )}
      {tutorialUrl && (
        <NeonButton
          className="guide-panel__tutorial"
          variant="secondary"
          icon={<IconExternalLink />}
          onClick={() => openExternal.mutate({ url: tutorialUrl })}
        >
          {t('screens.join.guide.tutorial')}
        </NeonButton>
      )}
    </PixelPanel>
  )
}
