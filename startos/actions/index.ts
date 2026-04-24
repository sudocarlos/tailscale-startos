import { sdk } from '../sdk'
import { addServe } from './addServe'
import { login } from './login'
import { removeServe } from './removeServe'

export const actions = sdk.Actions.of()
  .addAction(addServe)
  .addAction(login)
  .addAction(removeServe)
