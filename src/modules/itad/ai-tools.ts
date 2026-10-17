import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import jobsAiTools from './ai-tools/jobs-pack'
import assetsAiTools from './ai-tools/assets-pack'

/**
 * ITAD tools for the AI assistant (AI assistant spec, Epic 8). The generator reads the
 * default / `aiTools` export of this file. Phase 1: read tools and the customer status
 * draft only; no tool here writes.
 */
export const aiTools: AiToolDefinition[] = [...jobsAiTools, ...assetsAiTools]

export default aiTools
