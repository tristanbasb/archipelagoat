// vault:* handlers: the ROM vault, its scan, and the application of its ROMs to Archipelago's settings.
import { ROM_TABLE } from '@shared/data/rom-table'
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerVaultHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const vault = (): ReturnType<typeof services.get<'vault'>> => services.get('vault')

  register('vault:list', () => vault().list())

  // A task: a folder can hold many files to hash. Its result is the `RomRecord[]` of the scan.
  register('vault:scan', ({ paths }) =>
    Promise.resolve(services.ctx.tasks.start('rom-scan', (task) => vault().scan(paths, task))),
  )

  register('vault:remove', ({ path }) => vault().remove(path))

  register('vault:apply', () => vault().apply())

  // The ROMs Archipelago asks for, for the "supported games" list of the screen.
  register('vault:table', () => Promise.resolve(ROM_TABLE))
}
