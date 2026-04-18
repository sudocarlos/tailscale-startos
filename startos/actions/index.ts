import { sdk } from '../sdk'
import { manageServes } from './manageServes'
import { viewServes } from './viewServes'

export const actions = sdk.Actions.of()
  .addAction(manageServes)
  .addAction(viewServes)
