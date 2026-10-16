import { IconCheck } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { cx } from '../classes'
import './Stepper.css'

export interface StepperStep {
  id: string
  label: ReactNode
}

export interface StepperProps {
  steps: readonly StepperStep[]
  /** Id of the current step; the steps before it are done. */
  current: string
  /** Names the list of steps. */
  label?: string
  className?: string
}

type StepState = 'done' | 'current' | 'todo'

/** The wizard's progress: numbered pixel nodes on a rail. */
export function Stepper({ steps, current, label, className }: StepperProps): React.JSX.Element {
  const currentIndex = steps.findIndex((step) => step.id === current)
  return (
    <ol className={cx('stepper', className)} aria-label={label}>
      {steps.map((step, index) => {
        const state: StepState = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
        return (
          <li
            key={step.id}
            className={cx(
              'stepper__step',
              state === 'current' ? 'tone-violet' : state === 'done' ? 'tone-green' : 'tone-neutral',
            )}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="stepper__node" aria-hidden="true">
              {state === 'done' ? <IconCheck /> : String(index + 1).padStart(2, '0')}
            </span>
            <span className="stepper__label">{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
