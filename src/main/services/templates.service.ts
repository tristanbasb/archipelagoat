// The `templates` service: the option schemas of the Studio and the regeneration of the templates
// (Task 12).
import { createTemplates, type Templates } from '@main/core/ap/templates'
// The `locator` entry of Services, which this service uses.
import type {} from './locator.service'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    templates: Templates
  }
}

defineService('templates', (ctx, get) => createTemplates(ctx, { locator: get('locator') }), { eager: false })
