import { VersionGraph } from '@start9labs/start-sdk'
import { v_1_96_4_0 } from './v1.96.4.0'
import { v_1_96_5_0 } from './v1.96.5.0'

export const versionGraph = VersionGraph.of({
  current: v_1_96_5_0,
  other: [v_1_96_4_0],
})
