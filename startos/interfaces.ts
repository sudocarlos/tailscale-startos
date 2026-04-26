import { sdk } from './sdk'
import { UI_PORT, FILEBROWSER_PORT } from './constants'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const uiMulti = sdk.MultiHost.of(effects, 'ui')
  const uiOrigin = await uiMulti.bindPort(UI_PORT, {
    protocol: 'http',
    preferredExternalPort: UI_PORT,
  })

  const ui = sdk.createInterface(effects, {
    name: 'Web Interface',
    id: 'ui',
    description: 'Manage your Tailscale machine — login, subnet routes, exit node, and SSH',
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })

  const fileBrowserMulti = sdk.MultiHost.of(effects, 'taildrop-files')
  const fileBrowserOrigin = await fileBrowserMulti.bindPort(FILEBROWSER_PORT, {
    protocol: 'http',
    preferredExternalPort: FILEBROWSER_PORT,
  })

  const fileBrowser = sdk.createInterface(effects, {
    name: 'Taildrop Files',
    id: 'taildrop-files',
    description: 'Browse and download files received via Taildrop',
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })

  return [
    await uiOrigin.export([ui]),
    await fileBrowserOrigin.export([fileBrowser]),
  ]
})
