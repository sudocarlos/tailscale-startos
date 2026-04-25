import { sdk } from '../sdk'
import { storeJson } from '../fileModels/store.json'
import { setMachineName } from '../actions/setMachineName'

export const initializeService = sdk.setupOnInit(async (effects, kind) => {
  if (kind !== 'install') return

  // Write initial store defaults so the machine name action pre-fills correctly
  // and the startup oneshot has a well-typed value to read.
  await storeJson.write(effects, {
    machineName: 'startos',
    hostnameSet: false,
    serves: {},
    authKey: null,
  })

  // Create a critical task that blocks the service from starting until the
  // user confirms (or changes) the machine name.  The default is 'startos';
  // the user can accept it immediately or pick a custom name.
  await sdk.action.createOwnTask(effects, setMachineName, 'critical', {
    reason:
      'Set the name for your machine on your Tailscale network. ' +
      'Determines MagicDNS URL, startos.example.ts.net.',
  })
})
