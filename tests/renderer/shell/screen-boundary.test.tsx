import { screen, within } from '@testing-library/react'
import { ScreenBoundary } from '@renderer/layout/ScreenBoundary'
import { installGoatMock } from '../goat-mock'
import { renderWithProviders } from '../render-app'

describe('ScreenBoundary', () => {
  it('ScreenBoundary catches a throwing screen and reloads it', async () => {
    installGoatMock()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = true
    function Flaky(): React.JSX.Element {
      if (broken) throw new Error('kaboom: worlds list was undefined')
      return <h1>Mondes</h1>
    }

    const { user, queryClient } = await renderWithProviders(
      <ScreenBoundary>
        <Flaky />
      </ScreenBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Cet écran a planté' })).toBeInTheDocument()
    expect(within(alert).getByText(/kaboom: worlds list was undefined/)).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    broken = false
    await user.click(within(alert).getByRole('button', { name: 'Recharger l’écran' }))
    expect(screen.getByRole('heading', { name: 'Mondes' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('translates a GoatError thrown by a screen', async () => {
    installGoatMock()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Failing(): React.JSX.Element {
      // What `window.goat.invoke` rejects with: a plain object, not an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { name: 'GoatError', message: 'AP_NOT_INSTALLED', code: 'AP_NOT_INSTALLED' }
    }
    await renderWithProviders(
      <ScreenBoundary>
        <Failing />
      </ScreenBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Archipelago n’est pas installé')).toBeInTheDocument()
    expect(within(alert).getByRole('link', { name: 'Installer Archipelago' })).toHaveAttribute(
      'href',
      '/install',
    )
  })
})
