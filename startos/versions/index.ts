import { VersionGraph } from '@start9labs/start-sdk'
import { v_1_98_8_0 } from './v1.98.8.0'
import { v_1_96_4_0 } from './v1.96.4.0'
import { v_1_96_5_0 } from './v1.96.5.0'
import { v_1_96_5_2 } from './v1.96.5.2'
import { v_1_96_5_3 } from './v1.96.5.3'
import { v_1_98_4_0 } from './v1.98.4.0'

export const versionGraph = VersionGraph.of({
  current: v_1_98_8_0,
  other: [v_1_96_5_3, v_1_96_5_2, v_1_96_5_0, v_1_96_4_0, v_1_98_4_0],
})
