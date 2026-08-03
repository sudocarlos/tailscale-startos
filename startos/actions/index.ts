import { sdk } from '../sdk'
import { addServe } from './addServe'
import { getStarted } from './login'
import { removeServe } from './removeServe'
import { setControlServer } from './setControlServer'
import { setMachineName } from './setMachineName'

export const actions = sdk.Actions.of()
  .addAction(setMachineName)
  .addAction(setControlServer)
  .addAction(getStarted)
  .addAction(addServe)
  .addAction(removeServe)
