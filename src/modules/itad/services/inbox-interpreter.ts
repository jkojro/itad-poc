import { runAiAgentObject } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-runtime'
import type { AwilixContainer } from 'awilix'
import { untrusted } from '../lib/ai-tool-compose'
import { INBOX_INTERPRETER_AGENT_ID, inboxInterpretationSchema, type InboxInterpretation } from '../lib/inbox-interpreter-agent'

/**
 * Calls `itad.inbox_interpreter` for one email (spec "Interpret"). The model gets the
 * current message as the request, the earlier thread messages as possibly outdated
 * context (both delimited as untrusted), today's date, and the context matched by code;
 * nothing else. Runs as the system user of the message's organization — this only builds
 * the proposal and never widens what a person can read through the Inbox.
 */

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

export const INBOX_INTERPRETER_MODEL = 'anthropic/claude-haiku-5-5'

export type InterpreterContext = {
  tenantId: string
  organizationId: string
  today: string
  subject: string
  currentText: string
  history: string[]
  candidateJobs: Array<{ reference: string; status: string; scheduledPickupAt: string | null; customerReference: string | null }>
  openExceptions: Array<{ serial: string; type: string }>
  /** Customer-safe facts of the matched job, for a status reply. */
  jobFacts: string | null
}

export function buildInterpreterInput(context: InterpreterContext): string {
  return JSON.stringify(
    {
      today: context.today,
      currentMessage: untrusted({ subject: context.subject, body: context.currentText }),
      earlierMessages: context.history.slice(0, 5).map((body) => untrusted({ body })),
      matchedContext: {
        candidateJobs: context.candidateJobs,
        openMissingOrUnexpectedDevices: context.openExceptions,
      },
      jobFacts: context.jobFacts,
    },
    null,
    2,
  )
}

export type GenerateObjectOverride = Parameters<typeof runAiAgentObject>[0]['generateObject']

export async function interpretEmail(
  container: AwilixContainer,
  context: InterpreterContext,
  options: { generateObject?: GenerateObjectOverride } = {},
): Promise<InboxInterpretation> {
  const result = await runAiAgentObject({
    agentId: INBOX_INTERPRETER_AGENT_ID,
    input: buildInterpreterInput(context),
    authContext: {
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      userId: SYSTEM_USER_ID,
      features: ['itad.inbox.view'],
      isSuperAdmin: false,
    },
    container,
    ...(options.generateObject ? { generateObject: options.generateObject } : {}),
  })
  const object = result.mode === 'generate' ? result.object : await result.object
  return inboxInterpretationSchema.parse(object)
}
