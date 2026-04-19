import { sdk } from '../sdk'
import { addServe } from './addServe'
import { removeServe } from './removeServe'

export const actions = sdk.Actions.of()
  .addAction(addServe)
  .addAction(removeServe)
