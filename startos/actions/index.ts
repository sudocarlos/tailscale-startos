import { sdk } from '../sdk'
import { addServe } from './addServe'
import { disconnect } from './disconnect'
import { getStarted } from './login'
import { removeServe } from './removeServe'
import { setMachineName } from './setMachineName'

export const actions = sdk.Actions.of()
  .addAction(setMachineName)
  .addAction(getStarted)
  .addAction(disconnect)
  .addAction(addServe)
  .addAction(removeServe)
