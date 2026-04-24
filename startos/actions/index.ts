import { sdk } from '../sdk'
import { addServe } from './addServe'
import { getStarted } from './getStarted'
import { login } from './login'
import { removeServe } from './removeServe'

export const actions = sdk.Actions.of()
  .addAction(getStarted)
  .addAction(addServe)
  .addAction(login)
  .addAction(removeServe)
