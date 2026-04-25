import { sdk } from '../sdk'
import { setDependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { restoreInit } from '../backups'
import { actions } from '../actions'
import { getStarted } from '../actions/login'
import { registerUrlPlugin, exportUrls } from '../plugin/url'
import { initializeService } from './initializeService'
import type { Effects } from '@start9labs/start-sdk/base/lib/types'

async function scheduleGetStarted(
  effects: Effects,
  kind: 'install' | 'update' | 'restore' | null,
): Promise<void> {
  if (kind !== 'install') return
  await sdk.action.createOwnTask(effects, getStarted, 'important', {
    reason:
      'Authenticate Tailscale: provide an auth key for headless login, ' +
      'or open the Web UI to sign in interactively. ' +
      'Generate an auth key at https://login.tailscale.com/admin/settings/keys',
    replayId: 'get-started-first-launch',
  })
}

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  setDependencies,
  actions,
  registerUrlPlugin,
  exportUrls,
  initializeService,
  scheduleGetStarted,
)

export const uninit = sdk.setupUninit(versionGraph)
