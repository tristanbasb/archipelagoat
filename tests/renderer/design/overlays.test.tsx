import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { GoatApi } from '@shared/goat-api'
import { ConfirmDialog, Dropzone, Modal, ToastProvider, Tooltip, useToast } from '@renderer/design/components'
import { EffectsProvider } from '@renderer/design/useEffectsPrefs'

describe('Modal', () => {
  function Harness({ onClose }: { onClose?: () => void }): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const close = (): void => {
      onClose?.()
      setOpen(false)
    }
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Ouvrir
        </button>
        <Modal
          open={open}
          onClose={close}
          title="Installer ce monde ?"
          closeLabel="Fermer"
          footer={<button type="button">Installer</button>}
        >
          <p>Un APWorld exécute du code.</p>
        </Modal>
      </>
    )
  }

  it('renders nothing while closed', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens as a labelled modal dialog, takes focus and closes with Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Ouvrir' })
    await user.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Installer ce monde ?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    // Given back as soon as it closes, while it fades out: never left on the page meanwhile.
    expect(opener).toHaveFocus()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(opener).toHaveFocus()
  })

  it('never takes the focus back once it is closing, closed from its backdrop', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Ouvrir' })
    await user.click(opener)
    const backdrop = screen.getByRole('dialog').parentElement
    if (!backdrop) throw new Error('no backdrop')

    await user.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
    expect(opener).toHaveFocus()
    // Nothing pulls it back into the dialog that leaves.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opener).toHaveFocus()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(opener).toHaveFocus()
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 5; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
    await user.tab({ shift: true })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
  })

  it('takes focus back when its focused control goes away, and keeps Tab inside', async () => {
    // Its button gives way to a text while something runs, and it cannot be closed meanwhile.
    function Running(): React.JSX.Element {
      const [running, setRunning] = useState(false)
      return (
        <>
          <button type="button">Derrière</button>
          <Modal
            open
            onClose={() => undefined}
            dismissible={!running}
            title="Jeu prêt"
            closeLabel="Fermer"
            footer={
              running ? (
                <span>En cours</span>
              ) : (
                <button type="button" onClick={() => setRunning(true)}>
                  Lancer
                </button>
              )
            }
          />
        </>
      )
    }
    const user = userEvent.setup()
    render(<Running />)
    const dialog = screen.getByRole('dialog', { name: 'Jeu prêt' })
    await user.click(screen.getByRole('button', { name: 'Lancer' }))

    await waitFor(() => expect(dialog).toHaveFocus())
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByRole('button', { name: 'Derrière' })).not.toHaveFocus()
  })

  it('closes from its close button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))
    await user.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders inside the effects root so the fx classes apply to it', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <EffectsProvider effects={{ crt: false, glow: false, animations: false, sounds: false }}>
        <Harness />
      </EffectsProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Ouvrir' }))
    const root = container.querySelector('[data-fx-root]')
    expect(root).toContainElement(screen.getByRole('dialog'))
  })
})

describe('ConfirmDialog', () => {
  function Harness({ onConfirm }: { onConfirm: () => void }): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Rouvrir
        </button>
        <ConfirmDialog
          open={open}
          title="Retirer ce fichier ?"
          confirmLabel="Retirer"
          cancelLabel="Annuler"
          closeLabel="Fermer"
          onConfirm={() => {
            onConfirm()
            setOpen(false)
          }}
          onCancel={() => setOpen(false)}
        >
          <p>Une copie est gardée.</p>
        </ConfirmDialog>
      </>
    )
  }

  it('answers once per opening, whatever the clicks during its exit', async () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    const dialog = screen.getByRole('dialog', { name: 'Retirer ce fichier ?' })
    expect(dialog).toHaveTextContent('Une copie est gardée.')
    const confirm = screen.getByRole('button', { name: 'Retirer' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Opened again, it answers again.
    fireEvent.click(screen.getByRole('button', { name: 'Rouvrir' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retirer' }))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('cancels without confirming', async () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('Toast', () => {
  function Pusher(): React.JSX.Element {
    const toast = useToast()
    return (
      <>
        <button
          type="button"
          onClick={() => toast.push({ tone: 'ok', title: 'Partie générée', duration: 4000 })}
        >
          Toast court
        </button>
        <button
          type="button"
          onClick={() => toast.push({ tone: 'error', title: 'Serveur arrêté', duration: 0 })}
        >
          Toast collant
        </button>
      </>
    )
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows pushed toasts in a labelled region and dismisses them after their duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    render(
      <ToastProvider label="Notifications" closeLabel="Fermer">
        <Pusher />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Toast court' }))
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region).toHaveTextContent('Partie générée')

    await act(() => vi.advanceTimersByTime(4100))
    await waitFor(() => expect(screen.queryByText('Partie générée')).toBeNull())
  })

  it('keeps sticky toasts until closed, and announces errors as alerts', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider label="Notifications" closeLabel="Fermer">
        <Pusher />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Toast collant' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Serveur arrêté')
    await user.click(screen.getByRole('button', { name: 'Fermer' }))
    await waitFor(() => expect(screen.queryByText('Serveur arrêté')).toBeNull())
  })
})

describe('Tooltip', () => {
  it('describes its anchor on hover and focus, and hides on Escape', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Ouvre le dossier des mondes" delay={0}>
        <button type="button">Dossier</button>
      </Tooltip>,
    )
    const anchor = screen.getByRole('button', { name: 'Dossier' })
    expect(screen.queryByRole('tooltip')).toBeNull()

    await user.hover(anchor)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Ouvre le dossier des mondes')
    expect(anchor).toHaveAccessibleDescription('Ouvre le dossier des mondes')

    await user.unhover(anchor)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())

    await user.tab()
    expect(anchor).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })
})

describe('Dropzone', () => {
  beforeEach(() => {
    window.goat = {
      pathForFile: (file: File) => (file.name.startsWith('nopath') ? '' : `C:/drop/${file.name}`),
    } as GoatApi
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'goat')
  })

  function renderZone(): {
    onFiles: ReturnType<typeof vi.fn>
    onReject: ReturnType<typeof vi.fn>
    onBrowse: ReturnType<typeof vi.fn>
  } {
    const onFiles = vi.fn()
    const onReject = vi.fn()
    const onBrowse = vi.fn()
    render(
      <Dropzone
        accept={['.yaml', '.yml']}
        title="Dépose les YAML des joueurs"
        hint=".yaml, .yml"
        browseLabel="Parcourir"
        onFiles={onFiles}
        onReject={onReject}
        onBrowse={onBrowse}
      />,
    )
    return { onFiles, onReject, onBrowse }
  }

  const zone = (): HTMLElement => screen.getByRole('group', { name: 'Dépose les YAML des joueurs' })

  it('passes the paths of the accepted dropped files to onFiles', () => {
    const { onFiles, onReject } = renderZone()
    const files = [new File(['a'], 'Alice.yaml'), new File(['b'], 'notes.txt'), new File(['c'], 'BOB.YML')]
    fireEvent.drop(zone(), { dataTransfer: { files, types: ['Files'] } })
    expect(onFiles).toHaveBeenCalledWith(['C:/drop/Alice.yaml', 'C:/drop/BOB.YML'])
    expect(onReject).toHaveBeenCalledWith(['notes.txt'])
  })

  it('skips files without a path and does not call onFiles for nothing', () => {
    const { onFiles, onReject } = renderZone()
    fireEvent.drop(zone(), { dataTransfer: { files: [new File(['a'], 'nopath.yaml')], types: ['Files'] } })
    expect(onFiles).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledWith(['nopath.yaml'])
  })

  it('lights up while files are dragged over it', () => {
    renderZone()
    fireEvent.dragEnter(zone(), { dataTransfer: { files: [], types: ['Files'] } })
    expect(zone()).toHaveAttribute('data-active', 'true')
    fireEvent.dragLeave(zone(), { dataTransfer: { files: [], types: ['Files'] } })
    expect(zone()).not.toHaveAttribute('data-active')
  })

  it('opens the file picker from its browse button', async () => {
    const user = userEvent.setup()
    const { onBrowse } = renderZone()
    await user.click(screen.getByRole('button', { name: 'Parcourir' }))
    expect(onBrowse).toHaveBeenCalledOnce()
  })
})
