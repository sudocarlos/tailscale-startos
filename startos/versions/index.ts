import { VersionGraph } from '@start9labs/start-sdk'
import { v_1_96_4_0 } from './v1.96.4.0'
import { v_1_96_5_0 } from './v1.96.5.0'
import { v_1_96_5_2 } from './v1.96.5.2'
import { v_1_96_5_3 } from './v1.96.5.3'

export const versionGraph = VersionGraph.of({
  current: v_1_96_5_3,
  other: [v_1_96_5_2, v_1_96_5_0, v_1_96_4_0],
})
