import { sdk } from '../sdk'
import { addServe } from './addServe'
import { removeServe } from './removeServe'
import { setMachineName } from './setMachineName'

export const actions = sdk.Actions.of()
  .addAction(setMachineName)
  .addAction(addServe)
  .addAction(removeServe)
