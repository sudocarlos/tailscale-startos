import { sdk } from './sdk'
import { FILEBROWSER_PORT } from './constants'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const uiMulti = sdk.MultiHost.of(effects, 'ui')
  const uiOrigin = await uiMulti.bindPort(8080, {
    protocol: 'http',
    preferredExternalPort: 8080,
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
