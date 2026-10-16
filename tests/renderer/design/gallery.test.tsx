import { render, screen } from '@testing-library/react'
import { Gallery } from '@renderer/features/dev/Gallery'

describe('dev gallery', () => {
  it('renders every design component without errors', () => {
    const errors = vi.spyOn(console, 'error')
    render(<Gallery />)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    for (const name of [
      'NeonButton',
      'PlayerCard',
      'PixelPanel',
      'StatTile',
      'StatusPill',
      'Badge',
      'TrustBadge',
      'Stepper',
      'ProgressBar',
      'Spinner',
      'Toggle',
      'Segmented',
      'Select',
      'Combobox',
      'Slider',
      'WeightSlider',
      'CopyField',
      'Dropzone',
      'Terminal',
      'Tabs',
      'Modal',
      'Toast',
      'Tooltip',
      'Kbd',
      'EmptyState',
      'ErrorPanel',
      'CRTOverlay',
    ]) {
      expect(screen.getByRole('region', { name: new RegExp(`\\b${name}\\b`) }), name).toBeInTheDocument()
    }
    expect(errors).not.toHaveBeenCalled()
  })
})
