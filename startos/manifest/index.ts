import { setupManifest } from '@start9labs/start-sdk'
import i18n from './i18n'

export const manifest = setupManifest({
  id: 'tailscale',
  title: 'Tailscale',
  license: 'BSD-3-Clause',
  packageRepo: 'https://github.com/sudocarlos/tailscale-startos',
  upstreamRepo: 'https://github.com/tailscale/tailscale',
  marketingUrl: 'https://tailscale.com/',
  donationUrl: null,
  docsUrls: ['https://tailscale.com/docs/'],
  description: i18n.description,
  volumes: ['tailscale', 'startos'],
  images: {
    tailscale: {
      source: { dockerTag: 'ghcr.io/tailscale/tailscale:v1.96.5' },
      arch: ['x86_64', 'aarch64'],
    },
  },
  dependencies: {},
})
