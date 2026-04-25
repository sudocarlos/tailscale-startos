import { sdk } from './sdk'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const multi = sdk.MultiHost.of(effects, 'ui')
  const origin = await multi.bindPort(8080, {
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

  return [await origin.export([ui])]
})
