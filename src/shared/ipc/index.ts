// The merged IPC contract. Each domain lives in its own file; a channel name starts with its domain.
import { apChannels } from './ap'
import { appChannels } from './app'
import { bizhawkChannels } from './bizhawk'
import { catalogChannels } from './catalog'
import { doctorChannels } from './doctor'
import { joinChannels } from './join'
import { serverChannels } from './server'
import { sessionChannels } from './session'
import { studioChannels } from './studio'
import { systemChannels } from './system'
import { tasksChannels } from './tasks'
import { vaultChannels } from './vault'
import { webhostChannels } from './webhost'
import { worldsChannels } from './worlds'

export const domainChannels = {
  app: appChannels,
  tasks: tasksChannels,
  ap: apChannels,
  worlds: worldsChannels,
  catalog: catalogChannels,
  studio: studioChannels,
  session: sessionChannels,
  server: serverChannels,
  webhost: webhostChannels,
  join: joinChannels,
  vault: vaultChannels,
  bizhawk: bizhawkChannels,
  doctor: doctorChannels,
  system: systemChannels,
}

export const channels = {
  ...appChannels,
  ...tasksChannels,
  ...apChannels,
  ...worldsChannels,
  ...catalogChannels,
  ...studioChannels,
  ...sessionChannels,
  ...serverChannels,
  ...webhostChannels,
  ...joinChannels,
  ...vaultChannels,
  ...bizhawkChannels,
  ...doctorChannels,
  ...systemChannels,
}

export type Channels = typeof channels

export type { ChannelDef, ChannelInput, ChannelName, ChannelOutput, IpcResult } from './contract'
