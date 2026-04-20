import { sdk } from '../sdk'
import { setDependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { restoreInit } from '../backups'
import { actions } from '../actions'
import { registerUrlPlugin, exportUrls } from '../plugin/url'

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  setDependencies,
  actions,
  registerUrlPlugin,
  exportUrls,
)

export const uninit = sdk.setupUninit(versionGraph)
