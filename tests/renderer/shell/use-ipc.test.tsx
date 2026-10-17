import { onlineManager } from '@tanstack/react-query'
import { screen } from '@testing-library/react'
import { useEffect } from 'react'
import { useIpcMutation, useIpcQuery } from '@renderer/hooks/useIpc'
import { installGoatMock } from '../goat-mock'
import { renderWithProviders } from '../render-app'

/** Takes the browser offline the way Chromium does: navigator.onLine turns false, then `offline`. */
function goOffline(): () => void {
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  // TanStack Query only listens to the window events while something subscribes to it.
  const unsubscribe = onlineManager.subscribe(() => undefined)
  window.dispatchEvent(new Event('offline'))
  return () => {
    onLine.mockRestore()
    window.dispatchEvent(new Event('online'))
    unsubscribe()
  }
}

let restoreOnline: (() => void) | null = null

afterEach(() => {
  restoreOnline?.()
  restoreOnline = null
})

function Version(): React.JSX.Element {
  const info = useIpcQuery('app:getInfo', undefined)
  return <p>{info.data ? `version ${info.data.version}` : info.fetchStatus}</p>
}

function SaveLanguage(): React.JSX.Element {
  const save = useIpcMutation('app:setConfig')
  const { mutate } = save
  useEffect(() => mutate({ language: 'en' }), [mutate])
  return <p>{save.data ? `language ${save.data.language}` : save.status}</p>
}

describe('IPC queries without a network', () => {
  it('a query still resolves while the computer is offline (IPC is local)', async () => {
    installGoatMock()
    restoreOnline = goOffline()
    expect(navigator.onLine).toBe(false)
    expect(onlineManager.isOnline()).toBe(false)

    await renderWithProviders(<Version />)
    expect(await screen.findByText('version 0.1.0')).toBeInTheDocument()
  })

  it('a mutation still runs while the computer is offline', async () => {
    const goat = installGoatMock()
    restoreOnline = goOffline()

    await renderWithProviders(<SaveLanguage />)
    expect(await screen.findByText('language en')).toBeInTheDocument()
    expect(goat.inputsOf('app:setConfig')).toEqual([{ language: 'en' }])
  })
})
