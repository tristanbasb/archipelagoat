// A crash in one screen stays in that screen: the error, its detail, and a button that reloads it.
import { IconRefresh } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useRouteError } from 'react-router-dom'
import { isGoatError } from '@shared/errors'
import { ErrorPanel, NeonButton } from '../design/components'
import { describeError } from '../lib/errors'
import './ScreenBoundary.css'

interface BoundaryProps {
  /** A change (the route) clears the error. */
  resetKey?: string
  fallback: (error: unknown, reset: () => void) => ReactNode
  children?: ReactNode
}

interface BoundaryState {
  failed: boolean
  error: unknown
  resetKey: string | undefined
  /** Bumped by reset(), to mount the screen anew. */
  generation: number
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, error: null, resetKey: this.props.resetKey, generation: 0 }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, error }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey === state.resetKey) return null
    return { resetKey: props.resetKey, failed: false, error: null }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // React already reports the error; keep the component stack next to it for the logs.
    console.error('screen crashed', error, info.componentStack)
  }

  reset = (): void => {
    this.setState((state) => ({ failed: false, error: null, generation: state.generation + 1 }))
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback(this.state.error, this.reset)
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>
  }
}

function technicalDetail(error: unknown): string {
  if (isGoatError(error)) return [error.code, error.detail].filter(Boolean).join(': ')
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

function ScreenCrash({ error, onReload }: { error: unknown; onReload: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const described = isGoatError(error) ? describeError(error, t) : null
  const action = described?.action
  return (
    <div className="screen-crash">
      <ErrorPanel
        headingLevel={2}
        title={t('shell.boundary.title')}
        body={
          described ? (
            <>
              <strong className="screen-crash__cause">{described.title}</strong> {described.body}
            </>
          ) : (
            t('shell.boundary.body')
          )
        }
        detail={technicalDetail(error)}
        detailLabel={t('common.technicalDetails')}
        actions={
          <>
            <NeonButton icon={<IconRefresh />} onClick={onReload}>
              {t('shell.boundary.reload')}
            </NeonButton>
            {action?.to && (
              <Link to={action.to} className="screen-crash__link">
                {t(action.labelKey)}
              </Link>
            )}
          </>
        }
      />
    </div>
  )
}

/** Wraps a screen; "Reload the screen" mounts it again and refreshes every query. */
export function ScreenBoundary({
  children,
  resetKey,
}: {
  children?: ReactNode
  resetKey?: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  return (
    <Boundary
      resetKey={resetKey}
      fallback={(error, reset) => (
        <ScreenCrash
          error={error}
          onReload={() => {
            void queryClient.invalidateQueries()
            reset()
          }}
        />
      )}
    >
      {children}
    </Boundary>
  )
}

/** The router's last resort, when the layout itself crashed: only a full reload helps. */
export function RouteErrorFallback(): React.JSX.Element {
  const error = useRouteError()
  const { t } = useTranslation()
  return (
    <div className="screen-crash screen-crash--app">
      <ErrorPanel
        headingLevel={2}
        title={t('shell.boundary.appTitle')}
        body={t('shell.boundary.body')}
        detail={technicalDetail(error)}
        detailLabel={t('common.technicalDetails')}
        actions={
          <NeonButton icon={<IconRefresh />} onClick={() => window.location.reload()}>
            {t('shell.boundary.reloadApp')}
          </NeonButton>
        }
      />
    </div>
  )
}
