import { screen, waitFor, within } from '@testing-library/react'
import type { WorldInfo, WorldInstallPlan, WorldSource } from '@shared/types'
import { useWorldInstall } from '@renderer/hooks/useWorldInstall'
import { goatError, installGoatMock } from '../goat-mock'
import { renderWithProviders } from '../render-app'

const SHA = '3f8a9c0d1e2b4a5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b'
/** A world id is the sha1 of its path: never something to show. */
const CRYSTAL_ID = '9d4e1e23bd5b727046a9e3b4b7db57bd8d6ee684'
const MESSENGER_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'

function plan(overrides: Partial<WorldInstallPlan> = {}): WorldInstallPlan {
  return {
    planId: 'p1',
    source: { kind: 'file', path: 'C:\\Téléchargements\\pokemon_crystal.apworld' },
    module: 'pokemon_crystal',
    targetFileName: 'pokemon_crystal.apworld',
    manifest: {
      game: 'Pokemon Crystal',
      worldVersion: '3.1.0',
      minimumApVersion: '0.6.2',
      maximumApVersion: null,
      authors: ['AliceMousie', 'gerbiljames'],
      version: 7,
      compatibleVersion: 7,
    },
    sha256: SHA,
    trust: 'wiki-release',
    homepage: 'https://github.com/AliceMousie/Archipelago',
    conflicts: [{ worldId: CRYSTAL_ID, version: '3.0.2', winner: 'new' }],
    warnings: [],
    ...overrides,
  }
}

const WORLD = { id: CRYSTAL_ID, game: 'Pokemon Crystal' } as WorldInfo

/** The installed world the plan above replaces. */
const INSTALLED_CRYSTAL: WorldInfo = {
  id: CRYSTAL_ID,
  fileName: 'pokemon_crystal.apworld',
  path: 'C:\\ProgramData\\Archipelago\\custom_worlds\\pokemon_crystal.apworld',
  location: 'custom',
  module: 'pokemon_crystal',
  game: 'Pokemon Crystal',
  manifest: null,
  states: ['ok'],
  sizeBytes: 2048,
}

function Harness({ sources, onResult }: { sources: WorldSource[]; onResult: (r: unknown) => void }) {
  const { start, dialog, state } = useWorldInstall()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          for (const source of sources) void start(source).then(onResult)
        }}
      >
        Lancer
      </button>
      <output data-testid="state">{state}</output>
      {dialog}
    </>
  )
}

describe('useWorldInstall', () => {
  it('useWorldInstall requires acknowledgement before confirmInstall and toasts restartNeeded', async () => {
    const goat = installGoatMock({
      'worlds:prepareInstall': () => ({ taskId: 't1' }),
      'worlds:confirmInstall': () => ({ world: WORLD, restartNeeded: true }),
      'worlds:list': () => [INSTALLED_CRYSTAL],
    })
    const onResult = vi.fn()
    const source: WorldSource = { kind: 'file', path: 'C:\\Téléchargements\\pokemon_crystal.apworld' }
    const { user } = await renderWithProviders(<Harness sources={[source]} onResult={onResult} />)

    await user.click(screen.getByRole('button', { name: 'Lancer' }))
    expect(await screen.findByText('Analyse du monde…')).toBeInTheDocument()
    await waitFor(() => expect(goat.inputsOf('worlds:prepareInstall')).toEqual([{ source }]))
    goat.emit('task:progress', { taskId: 't1', kind: 'world-prepare', stage: 'inspect', percent: 50 })
    // The progress names the stage the inspection is at.
    expect(await screen.findByRole('progressbar', { name: 'Analyse du fichier' })).toBeInTheDocument()
    goat.emit('task:done', { taskId: 't1', kind: 'world-prepare', result: plan() })

    const dialog = await screen.findByRole('dialog', { name: 'Installer Pokemon Crystal\u00a0?' })
    expect(within(dialog).getByText('AliceMousie, gerbiljames')).toBeInTheDocument()
    expect(within(dialog).getByText('3f8a9c0d1e2b…6e7f8a9b')).toBeInTheDocument()
    expect(within(dialog).getByText('Release du wiki')).toBeInTheDocument()
    // The replaced world by its file, game and version (its id is a hash).
    expect(
      await within(dialog).findByText(
        'pokemon_crystal.apworld remplacera pokemon_crystal.apworld (Pokemon Crystal 3.0.2)',
      ),
    ).toBeInTheDocument()

    const install = within(dialog).getByRole('button', { name: 'Installer' })
    expect(install).toBeDisabled()
    await user.click(install)
    expect(goat.inputsOf('worlds:confirmInstall')).toEqual([])

    await user.click(within(dialog).getByRole('checkbox', { name: 'J’ai compris' }))
    expect(install).toBeEnabled()
    await user.click(install)

    await waitFor(() => expect(goat.inputsOf('worlds:confirmInstall')).toEqual([{ planId: 'p1' }]))
    expect(await screen.findByText('Redémarre les programmes Archipelago ouverts')).toBeInTheDocument()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ installed: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('state')).toHaveTextContent('idle')
  })

  it('names the conflicting worlds from the worlds list, never by their id', async () => {
    const goat = installGoatMock({
      'worlds:prepareInstall': () => ({ taskId: 't1' }),
      'worlds:list': () => [
        {
          ...INSTALLED_CRYSTAL,
          location: 'core',
          path: 'C:\\ProgramData\\Archipelago\\lib\\worlds\\pokemon_crystal.apworld',
        },
      ],
    })
    const { user } = await renderWithProviders(
      <Harness sources={[{ kind: 'catalog', id: 'pokemon_crystal' }]} onResult={() => undefined} />,
    )
    await user.click(screen.getByRole('button', { name: 'Lancer' }))
    await waitFor(() => expect(goat.inputsOf('worlds:prepareInstall')).toHaveLength(1))
    goat.emit('task:done', {
      taskId: 't1',
      kind: 'world-prepare',
      result: plan({
        conflicts: [
          { worldId: CRYSTAL_ID, version: null, winner: 'existing' },
          // Gone from the list (removed meanwhile): a neutral label stands in for it.
          { worldId: MESSENGER_ID, version: '1.2.0', winner: 'new' },
        ],
      }),
    })

    const dialog = await screen.findByRole('dialog', { name: 'Installer Pokemon Crystal\u00a0?' })
    expect(
      await within(dialog).findByText(
        'pokemon_crystal.apworld (Pokemon Crystal) reste prioritaire sur pokemon_crystal.apworld',
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('pokemon_crystal.apworld remplacera un monde déjà installé'),
    ).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent(CRYSTAL_ID)
    expect(dialog).not.toHaveTextContent(MESSENGER_ID)
  })

  it('queues successive installs and resolves a cancelled one as not installed', async () => {
    let next = 0
    const goat = installGoatMock({
      'worlds:prepareInstall': () => ({ taskId: `t${++next}` }),
      'worlds:confirmInstall': () => ({ world: WORLD, restartNeeded: false }),
      'tasks:cancel': () => undefined,
    })
    const onResult = vi.fn()
    const { user } = await renderWithProviders(
      <Harness
        sources={[
          { kind: 'catalog', id: 'celeste' },
          { kind: 'url', url: 'https://github.com/x/y/releases/download/v1/hk.apworld' },
        ]}
        onResult={onResult}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Lancer' }))
    await waitFor(() => expect(goat.inputsOf('worlds:prepareInstall')).toHaveLength(1))
    expect(screen.getByText('1 en attente')).toBeInTheDocument()

    // The first one is still being inspected: cancelling stops its task.
    await user.click(await screen.findByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ installed: false }))
    expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 't1' }])

    await waitFor(() => expect(goat.inputsOf('worlds:prepareInstall')).toHaveLength(2))
    goat.emit('task:failed', { taskId: 't2', kind: 'world-prepare', error: goatError('WORLD_INVALID') })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Ce fichier n’est pas un APWorld valide')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Fermer' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2))
    expect(onResult).toHaveBeenLastCalledWith({ installed: false })
  })

  it('gives up the waiting installs when the screen goes away', async () => {
    const goat = installGoatMock({
      'worlds:prepareInstall': () => ({ taskId: 't1' }),
      'tasks:cancel': () => undefined,
    })
    const onResult = vi.fn()
    const { user, unmount } = await renderWithProviders(
      <Harness
        sources={[
          { kind: 'catalog', id: 'celeste' },
          { kind: 'catalog', id: 'hk' },
        ]}
        onResult={onResult}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Lancer' }))
    await waitFor(() => expect(goat.inputsOf('worlds:prepareInstall')).toHaveLength(1))
    expect(await screen.findByText('1 en attente')).toBeInTheDocument()
    goat.emit('task:progress', { taskId: 't1', kind: 'world-prepare', stage: 'inspect', percent: 30 })
    expect(await screen.findByText('30%')).toBeInTheDocument()

    unmount()
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2))
    expect(onResult.mock.calls).toEqual([[{ installed: false }], [{ installed: false }]])
    expect(goat.inputsOf('tasks:cancel')).toEqual([{ taskId: 't1' }])
  })
})
