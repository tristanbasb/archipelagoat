// The `pickedPaths` service: the files the user picked in this run (app:savePath, the Studio's dialogs
// and opened files), shared by everything that writes a file at a path the renderer names.
import { createPickedPaths, type PickedPaths } from '@main/core/system/picked-paths'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    pickedPaths: PickedPaths
  }
}

defineService('pickedPaths', (ctx) => createPickedPaths(ctx.platform.os), { eager: false })
