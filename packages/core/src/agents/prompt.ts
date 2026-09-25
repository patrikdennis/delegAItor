import type { PlannedTicket } from "../types.js";

export interface PromptContext {
  ticket: PlannedTicket;
  sessionId: string;
}

/**
 * Standard prompt every agent runtime receives. Keeps the actual
 * ticket-worker behavior in one place regardless of which CLI (Claude,
 * Copilot, Codex, OpenCode) is running it, so behavior stays consistent
 * across runtimes.
 */
export function buildTicketPrompt({ ticket, sessionId }: PromptContext): string {
  const conflictNote = ticket.conflictsWith.length
    ? `\nNote: ticket(s) ${ticket.conflictsWith.join(", ")} in this same batch were flagged as ` +
      `possibly touching overlapping files. Before editing a file, run ` +
      `\`delegaitor lock acquire --session ${sessionId} --ticket ${ticket.id} --resource <path>\` ` +
      `to check for conflicts.`
    : "";

  return `You are working a single delegated ticket in an isolated git worktree/branch.
Do not touch files outside this repository's scope for this ticket, and do not
merge, push, or force-push unless explicitly instructed to.

Ticket: ${ticket.title}
Source: ${ticket.source}${ticket.externalUrl ? ` (${ticket.externalUrl})` : ""}
Repository: ${ticket.repoId}
Branch: ${ticket.branch}
Worktree: ${ticket.worktreePath}
Session id: ${sessionId}
Ticket id: ${ticket.id}
${conflictNote}

${ticket.body ? `--- Ticket details ---\n${ticket.body}\n---` : ""}

Coordination protocol (delegAItor CLI is on PATH):
- Before editing a shared/cross-cutting resource (a file, service, or migration
  another ticket in this batch might also touch), run:
    delegaitor lock acquire --session ${sessionId} --ticket ${ticket.id} --resource <path-or-name>
  If it's already held by another session, STOP editing that resource and run:
    delegaitor message send --session ${sessionId} --to-ticket <other-ticket-id> \\
      --kind conflict --body "<what you need / propose>"
  then wait and poll with:
    delegaitor message inbox --ticket ${ticket.id}
- When you finish with a locked resource, release it:
    delegaitor lock release --session ${sessionId} --resource <path-or-name>
- Periodically check your inbox for messages from other sessions:
    delegaitor message inbox --ticket ${ticket.id}
- When you are done (or blocked), report status:
    delegaitor session complete --session ${sessionId} --status ready_for_review --summary "<summary>"
    delegaitor session complete --session ${sessionId} --status blocked --summary "<why>"

Work the ticket to completion: implement the change, run the relevant tests/
linters for what you touched, and commit your work on this branch with a clear
message before reporting completion.`;
}
