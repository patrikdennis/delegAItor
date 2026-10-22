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
      `\`delegaitor lock acquire --session ${sessionId} --ticket ${ticket.id} --repo ${ticket.repoId} --resource <path>\` ` +
      `to check for conflicts.`
    : "";

  const naming = ticket.branchNaming;
  const branchNote = ticket.coordinationUnits || !naming
    ? ""
    : naming.locked
      ? `\nBranch naming: the user set the "${naming.prefix}" prefix explicitly. Keep it.`
      : `\nBranch naming: the "${naming.prefix}" prefix was guessed before anyone read the ticket (${naming.reason}).
Prefixes for this repo (from ${naming.origin}):
${naming.options.map((o) => `  ${o.prefix.padEnd(12)} ${o.description}`).join("\n")}
Once you understand the ticket, and before your first push, check the prefix fits.
If another one fits better, switch it (this keeps the rest of the branch name):
    delegaitor session rename-branch --session ${sessionId} --prefix <prefix>`;
  const repoCoordination = ticket.coordinationUnits
    ? `\nThis ticket has one session and ${ticket.coordinationUnits.length} isolated repository worktree(s).
The workspace container is ${ticket.workspacePath}; each listed folder is a symlink to its dedicated worktree.
The original clones are read-only context and must never be edited.
Configured catalog (the complete allowed scope; do not scan or edit other repositories):
${ticket.coordinationUnits.map((unit) =>
  `  - ${unit.alias} (${unit.repoId}): folder ${ticket.workspacePath}/${unit.alias}, worktree ${unit.worktreePath}, branch ${unit.branch}, base ${unit.baseRef}` +
    (unit.branchNaming ? `, prefix ${unit.branchNaming.prefix || "(none)"}, allowed prefixes ${unit.branchNaming.options.map((option) => option.prefix).join(", ") || "(any)"}` : ""),
).join("\n")}
Read the ticket, inspect only these worktrees, decide which repos are affected, and make changes only in those worktree folders. Do not create work in a repo that does not need a change. Report affected and no-change repos distinctly.`
    : "";

  return `You are working one delegated ticket in isolated git worktree(s).
Do not edit original repository clones or files outside the configured worktree scope.
Do not merge, push, or force-push unless explicitly instructed to.

Ticket: ${ticket.title}
Source: ${ticket.source}${ticket.externalUrl ? ` (${ticket.externalUrl})` : ""}
${ticket.coordinationUnits ? `Workspace: ${ticket.workspacePath}` : `Repository: ${ticket.repoId}
Branch: ${ticket.branch}
Worktree: ${ticket.worktreePath}`}
Session id: ${sessionId}
Ticket id: ${ticket.id}
${conflictNote}${branchNote}${repoCoordination}

${ticket.body ? `--- Ticket details ---\n${ticket.body}\n---` : ""}

Coordination protocol (delegAItor CLI is on PATH):
- Before editing a shared/cross-cutting resource (a file, service, or migration
  another ticket in this batch might also touch), run:
    delegaitor lock acquire --session ${sessionId} --ticket ${ticket.id} --repo <owner/repo-from-catalog> --resource <path-or-name>
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
    delegaitor session complete --session ${sessionId} --status blocked --summary "<the exact question for the user>"
  When blocked, stop and wait: the user's answer arrives as a new message in
  this session.
- For a multi-repository ticket, use one session completion after reviewing
  every configured worktree. Report each repo as affected or no-change in the
  completion summary. Only repos with committed changes need a pull request.
- Don't push or open a pull request unless the user asks. When they do, run:
    delegaitor ticket ship ${sessionId} --title "<title>" --body "<why, what changed, how it was tested>"

Work the ticket to completion: implement the change, run the relevant tests/
linters for what you touched, and commit your work on this branch with a clear
message before reporting completion.`;
}
