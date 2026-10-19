import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import jobsAiTools from './ai-tools/jobs-pack'
import assetsAiTools from './ai-tools/assets-pack'
import writesAiTools from './ai-tools/writes-pack'

/**
 * ITAD tools for the AI assistant (AI assistant spec, Epic 8). The generator reads the
 * default / `aiTools` export of this file: the read tools and the customer status
 * draft (phase 1) and the writes behind the approval card (phase 2: resolve exception,
 * reschedule pickup).
 */
export const aiTools: AiToolDefinition[] = [...jobsAiTools, ...assetsAiTools, ...writesAiTools]

export default aiTools
