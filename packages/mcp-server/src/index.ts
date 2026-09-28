#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  persistPlan,
  dispatchTicket,
  listSessions,
  completeSession,
  renameSessionBranch,
  closeTicket,
  shipTicket,
  ticketOverview,
  ticketContext,
  readSessionScreen,
  nudgeSession,
  cleanupSession,
  listCleanupCandidates,
  resolveExecutionPlan,
  acquireLock,
  releaseLock,
  listActiveLocks,
  sendMessage,
  unreadMessagesFor,
  markRead,
  getDb,
  syncBoardStatus,
  BOARD_LIFECYCLE,
  getProfile,
  mergeProfile,
  cleanProfile,
  profileToResolveOptions,
  saveProfile,
  listProfiles,
  removeProfile,
  type DispatchProfile,
  type ExecutionPlan,
} from "@delegaitor/core";

const server = new McpServer({ name: "delegaitor", version: "0.1.0" });

const AgentEnum = z.enum(["claude", "copilot", "codex", "opencode"]);
const CleanupModeWorktree = z.enum(["never", "if-clean", "force"]);
const CleanupModeBranch = z.enum(["never", "if-merged", "force"]);

/** Shared ticket-source input fields for delegaitor_plan and delegaitor_dispatch. */
const ticketSourceInputSchema = {
  profile: z
    .string()
    .optional()
    .describe(
      "Name of a saved profile (see delegaitor_profile_list) holding the board, filters, repo and board " +
        "statuses. Any other field you pass overrides the profile's value.",
    ),
  text: z
    .string()
    .optional()
    .describe("Ticket references or a markdown-style ticket list. Optional when a board source (e.g. a profile) is given."),
  agent: AgentEnum.optional().describe("Default agent runtime to assign to each ticket (default: claude)"),
  repo: z.string().optional().describe('Default repo as "owner/repo"'),
  repoPath: z.string().optional().describe("Local filesystem path of --repo; defaults to cwd"),
  base: z.string().optional().describe("Default base branch, defaults to main"),
  branchPrefix: z
    .string()
    .optional()
    .describe(
      'Forces this prefix on every branch, e.g. "fix/" ("" for none). Omit to pick a prefix per ticket from the repo\'s branch prefix rules.',
    ),
  branchRules: z
    .string()
    .optional()
    .describe("Path to a branch-prefixes.json file describing the team's branch prefixes"),
  all: z
    .boolean()
    .optional()
    .describe(
      "Pull every ticket on shared boards (Notion/Linear/Jira), not just those assigned to you. " +
        "Explicit ticket titles/ids/URLs in `text` always override this filter.",
    ),
  githubMine: z.boolean().optional().describe("Also pull open GitHub issues assigned to you in `repo`"),
  githubComments: z
    .boolean()
    .optional()
    .describe("Also fetch each GitHub issue's comment thread and include it as ticket context"),
  notionDatabaseId: z.string().optional().describe("Notion database id to also pull tickets from"),
  notionAssigneeId: z
    .string()
    .optional()
    .describe(
      "Your Notion user id. Only needed for shared/workspace-owned Notion integration tokens, where " +
        "delegAItor can't auto-detect which teammate is running it.",
    ),
  notionStatuses: z
    .array(z.string())
    .optional()
    .describe(
      "Status values to delegate, exactly as they appear on your board's Status column (e.g. " +
        '["Not started", "Backlog"]). Board columns are named however each team likes, so there\'s no ' +
        "fixed default — omit to pull every status.",
    ),
  notionTitleProp: z
    .string()
    .optional()
    .describe('Notion title property name, if not "Name" (e.g. "Task").'),
  notionStatusProp: z
    .string()
    .optional()
    .describe('Notion status/select property name, if not "Status". Used for notionStatuses filtering and board moves.'),
  notionBodyProp: z
    .string()
    .optional()
    .describe(
      "Notion rich-text property to use as extra ticket body/spec (in addition to page content), e.g. \"Spec\".",
    ),
  notionProjectProp: z
    .string()
    .optional()
    .describe(
      "Notion property exposing a human-readable project/initiative name, used with notionProjects to " +
        "scope one project on a shared multi-project board. A plain select/status property works " +
        "directly; a relation to a separate Projects database only exposes an opaque id, so point this " +
        "at a rollup property that surfaces the related project's title instead.",
    ),
  notionProjects: z
    .array(z.string())
    .optional()
    .describe(
      "Project/initiative names to delegate (requires notionProjectProp). Every workspace organizes " +
        "projects differently, so there's no default — omit to pull tickets from every project.",
    ),
  notionIncludePageContent: z
    .boolean()
    .optional()
    .describe(
      "Fetch each Notion page's actual body content (the paragraphs/lists written below the " +
        "properties — the same text visible scrolling down the page) and include it as ticket context. " +
        "Set to false to skip this and rely solely on notionBodyProp.",
    ),
  linear: z.boolean().optional().describe("Also pull tickets from Linear (uses LINEAR_API_KEY)"),
  linearTeamKey: z.string().optional().describe("Restrict Linear to one team key, e.g. ENG"),
  linearStatuses: z
    .array(z.string())
    .optional()
    .describe(
      "Workflow state names to delegate, exactly as they appear on your team's board (e.g. " +
        '["Backlog", "Todo"]). Omit to pull any non-completed/non-canceled state.',
    ),
  jiraProject: z
    .string()
    .optional()
    .describe("Pull tickets from this Jira project (uses JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)"),
  jiraJql: z.string().optional().describe("Custom JQL, overrides the default mine/project query"),
  jiraStatuses: z
    .array(z.string())
    .optional()
    .describe(
      "Status names to delegate, exactly as they appear on your board (e.g. [\"Selected for Development\"]). " +
        "Omit to use the default statusCategory != Done. Ignored if jiraJql is supplied.",
    ),
  boardStatuses: z
    .object({
      in_progress: z.string().optional().describe("Status to move each ticket to when its agent session starts"),
      ready_for_review: z.string().optional().describe("Status to move to when the session completes as ready_for_review"),
      blocked: z.string().optional().describe("Status to move to when the session reports blocked"),
      done: z.string().optional().describe("Status to move to when the session completes as done"),
    })
    .optional()
    .describe(
      "Board status names to move Notion/Linear/Jira tickets to as their sessions progress, exactly as named on " +
        'the board (e.g. { in_progress: "In progress", ready_for_review: "Ready for review" }). Columns are named ' +
        "differently on every board, so nothing is moved unless a name is given for that stage.",
    ),
};

type PlanArgs = DispatchProfile & { profile?: string; text?: string };

function planArgsToProfile({ profile, text: _text, ...args }: PlanArgs): DispatchProfile {
  return profile ? mergeProfile(getProfile(profile), args) : cleanProfile(args);
}

async function resolvePlan(args: PlanArgs): Promise<ExecutionPlan> {
  return resolveExecutionPlan(args.text ?? "", profileToResolveOptions(planArgsToProfile(args)));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

server.registerTool(
  "delegaitor_plan",
  {
    title: "Plan ticket delegation",
    description:
      "Resolves ticket text (GitHub issue refs like #123, a markdown ticket list, or Notion filter lines) " +
      "into a concrete execution plan (branch names, worktree paths, agent assignment, flagged conflicts) " +
      "WITHOUT creating any worktrees or launching any agents. Use this to preview before delegaitor_dispatch.",
    inputSchema: ticketSourceInputSchema,
  },
  async (args) => {
    const plan = await resolvePlan(args);
    return jsonResult(plan);
  },
);

server.registerTool(
  "delegaitor_dispatch",
  {
    title: "Dispatch tickets to isolated worktrees and agent sessions",
    description:
      "Resolves ticket text into a plan, persists it, then for each ticket creates a dedicated git " +
      "branch+worktree and launches an agent session (in a new cmux workspace if available, otherwise a " +
      "detached background process). Returns session ids needed for delegaitor_lock_*, delegaitor_message_*, " +
      "and delegaitor_session_complete.",
    inputSchema: ticketSourceInputSchema,
  },
  async (args) => {
    const plan = await resolvePlan(args);
    if (!plan.tickets.length) return textResult("No tickets resolved from input.");
    persistPlan(plan, args.text ?? "");

    const results = [];
    for (const ticket of plan.tickets) {
      try {
        const result = await dispatchTicket(plan, ticket);
        results.push({
          ticketId: ticket.id,
          title: ticket.title,
          sessionId: result.sessionId,
          branch: ticket.branch,
          worktreePath: result.worktreePath,
          launchMethod: result.launch.method,
          cmuxWorkspaceId: result.launch.cmuxWorkspaceId,
          boardStatus: result.boardStatus,
        });
      } catch (err) {
        results.push({ ticketId: ticket.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return jsonResult({ runId: plan.runId, tickets: results });
  },
);

server.registerTool(
  "delegaitor_profile_list",
  {
    title: "List saved dispatch profiles",
    description:
      "Lists saved profiles: named sets of plan/dispatch options (board, filters, repo, agent, board statuses). " +
        "Pass a profile's name as `profile` to delegaitor_plan/delegaitor_dispatch instead of every option.",
    inputSchema: {},
  },
  async () => jsonResult(listProfiles()),
);

const { text: _t, profile: _p, ...profileFields } = ticketSourceInputSchema;

server.registerTool(
  "delegaitor_profile_save",
  {
    title: "Save a dispatch profile",
    description:
      "Saves plan/dispatch options under a name for later use with `profile`. With merge: true only the given " +
        "fields change; otherwise the profile is replaced. repoPath should be an absolute path to the local clone. " +
        "Check the options with delegaitor_plan first so the saved profile is known to resolve the right tickets.",
    inputSchema: {
      name: z.string().describe('Profile name, e.g. "my-board"'),
      description: z.string().optional().describe("What the profile is for"),
      merge: z.boolean().optional(),
      ...profileFields,
    },
  },
  async ({ name, merge, ...fields }) => jsonResult({ name, profile: saveProfile(name, fields as DispatchProfile, { merge }) }),
);

server.registerTool(
  "delegaitor_profile_remove",
  {
    title: "Remove a dispatch profile",
    description: "Deletes a saved profile.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => textResult(removeProfile(name) ? `Removed profile "${name}".` : `No profile named "${name}".`),
);

server.registerTool(
  "delegaitor_status",
  {
    title: "Get ticket and session status",
    description: "Lists delegated tickets and their agent sessions, optionally filtered to one ticket id.",
    inputSchema: { ticketId: z.string().optional() },
  },
  async ({ ticketId }) => {
    const rows = getDb()
      .prepare(
        `SELECT id, title, repo_id as repoId, status FROM tickets ${ticketId ? "WHERE id = ?" : ""} ORDER BY created_at DESC`,
      )
      .all(...(ticketId ? [ticketId] : [])) as { id: string; title: string; repoId: string; status: string }[];
    const withSessions = rows.map((t) => ({ ...t, sessions: listSessions({ ticketId: t.id }) }));
    return jsonResult(withSessions);
  },
);

server.registerTool(
  "delegaitor_lock_acquire",
  {
    title: "Acquire a resource lock",
    description:
      "Requests an advisory lock on a named resource (a file path, service, or migration id) before editing " +
      "something another concurrent session might also touch. Returns ok:true if acquired, or ok:false with " +
      "the session/ticket already holding it so you can coordinate via delegaitor_message_send.",
    inputSchema: {
      sessionId: z.string(),
      ticketId: z.string(),
      resource: z.string(),
      repoId: z.string().optional().describe("Defaults to the ticket's repo"),
    },
  },
  async ({ sessionId, ticketId, resource, repoId }) => {
    const repo = repoId ?? repoIdForTicket(ticketId);
    return jsonResult(acquireLock({ repoId: repo, resource, ticketId, sessionId }));
  },
);

server.registerTool(
  "delegaitor_lock_release",
  {
    title: "Release a resource lock",
    inputSchema: { sessionId: z.string(), resource: z.string() },
  },
  async ({ sessionId, resource }) => {
    releaseLock(sessionId, resource);
    return textResult(`Released "${resource}"`);
  },
);

server.registerTool(
  "delegaitor_lock_list",
  {
    title: "List active resource locks",
    inputSchema: { repoId: z.string().optional() },
  },
  async ({ repoId }) => jsonResult(listActiveLocks(repoId)),
);

server.registerTool(
  "delegaitor_message_send",
  {
    title: "Send a message to another session working the same ticket",
    description:
      "Sends a message either to one specific session (toSessionId) or broadcast to every session assigned " +
      "to a ticket (toTicketId). Use kind 'conflict' when blocked on a locked resource, 'question' when you " +
      "need input, and 'answer'/'done' to close the loop.",
    inputSchema: {
      fromSessionId: z.string(),
      toTicketId: z.string().optional(),
      toSessionId: z.string().optional(),
      body: z.string(),
      kind: z.enum(["note", "conflict", "question", "answer", "blocked", "done"]).default("note"),
    },
  },
  async (args) => jsonResult({ messageId: sendMessage(args) }),
);

server.registerTool(
  "delegaitor_message_inbox",
  {
    title: "Read unread messages",
    inputSchema: {
      ticketId: z.string().optional(),
      sessionId: z.string().optional(),
      markRead: z.boolean().default(false),
    },
  },
  async ({ ticketId, sessionId, markRead: shouldMarkRead }) => {
    const msgs = unreadMessagesFor({ ticketId, sessionId });
    if (shouldMarkRead) for (const m of msgs) markRead(m.id);
    return jsonResult(msgs);
  },
);

server.registerTool(
  "delegaitor_session_complete",
  {
    title: "Report a session as finished or blocked",
    description:
      "Marks a session's outcome (e.g. status 'ready_for_review', 'blocked', 'done') and releases any locks " +
      "it still holds so other sessions can proceed. If board statuses were configured at dispatch, this also " +
      "moves the source ticket (Notion/Linear/Jira) to the matching column; the result is returned as boardStatus.",
    inputSchema: { sessionId: z.string(), status: z.string(), summary: z.string().optional() },
  },
  async ({ sessionId, status, summary }) => {
    const result = await completeSession(sessionId, status, summary);
    return jsonResult({ sessionId, status, boardStatus: result.boardStatus ?? null });
  },
);

server.registerTool(
  "delegaitor_branch_rename",
  {
    title: "Change the prefix of a session's branch",
    description:
      "Swaps the prefix of the session's branch (e.g. feature/ -> fix/), keeping the rest of the name. Only " +
      "prefixes listed in the ticket prompt are allowed, and only before the branch has been pushed.",
    inputSchema: { sessionId: z.string(), prefix: z.string().describe('e.g. "fix/"') },
  },
  async ({ sessionId, prefix }) => jsonResult(await renameSessionBranch(sessionId, prefix)),
);

server.registerTool(
  "delegaitor_overview",
  {
    title: "What each delegated ticket needs next",
    description:
      "One entry per open ticket (its latest session) with `next`: unblock (agent is blocked), ship (done but no " +
      "PR), review (PR open), address review (changes requested), close (PR merged), working, or check (failed). " +
      "Includes the PR (via gh), the agent's summary, unread messages and held locks.",
    inputSchema: {
      includeFinished: z.boolean().optional(),
      pullRequests: z.boolean().optional().describe("Look up PRs with gh (default true)"),
    },
  },
  async (args) => jsonResult(await ticketOverview(args)),
);

server.registerTool(
  "delegaitor_ticket_ship",
  {
    title: "Push a ticket's branch and open its pull request",
    description:
      "Pushes the ticket's branch and opens a PR against its base branch with a link to the ticket (or returns the " +
      "already-open PR), then marks the session ready_for_review, which moves the board card if configured. " +
      "Refuses with uncommitted changes or no commits. Never force-pushes. Write a real title and body summarizing " +
      "the change for reviewers; the default body is just the commit list.",
    inputSchema: {
      ref: z.string().describe("Session id, ticket id, or branch name"),
      title: z.string().optional().describe("PR title (default: ticket title)"),
      body: z.string().optional().describe("PR description in markdown; a ticket link is appended"),
      draft: z.boolean().optional(),
      markReady: z.boolean().optional().describe("Mark the session ready_for_review (default true)"),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ ref, ...opts }) => jsonResult(await shipTicket(ref, opts)),
);

server.registerTool(
  "delegaitor_ticket_context",
  {
    title: "Get a ticket's requirements and diff for review",
    description:
      "Returns the ticket's title, body (including the discussion fetched from the board), the agent's summary, " +
      "the PR, commits, diffstat, uncommitted files and the diff against the base branch (capped at maxDiffBytes).",
    inputSchema: {
      ref: z.string().describe("Session id, ticket id, or branch name"),
      diff: z.boolean().optional().describe("Include the full diff (default true)"),
      maxDiffBytes: z.number().int().positive().optional(),
    },
  },
  async ({ ref, ...opts }) => jsonResult(await ticketContext(ref, opts)),
);

server.registerTool(
  "delegaitor_session_screen",
  {
    title: "Read a session's terminal",
    description: "Returns the last lines of a session's cmux tab, e.g. to see the question a blocked agent asked.",
    inputSchema: { ref: z.string(), lines: z.number().int().positive().optional() },
  },
  async ({ ref, lines }) => textResult(await readSessionScreen(ref, lines)),
);

server.registerTool(
  "delegaitor_session_nudge",
  {
    title: "Reply to a session's agent",
    description:
      "Types text into a session's agent prompt in its cmux tab and presses Enter, as if the user replied there. " +
      "A blocked session is marked running again and its board card moved back to in progress. Newlines are sent " +
      "as spaces. Only send what the user approved.",
    inputSchema: { ref: z.string(), text: z.string(), resume: z.boolean().optional() },
  },
  async ({ ref, text, resume }) => jsonResult(await nudgeSession(ref, text, { resume })),
);

server.registerTool(
  "delegaitor_ticket_close",
  {
    title: "Close a finished ticket",
    description:
      "Closes a delegated ticket once its work has landed: removes the worktree, deletes the local and remote " +
      "branch, marks the session done, moves the board card to the done column (if configured), and closes the " +
      "ticket's cmux tab last (which ends the agent running in it). Refuses if the pull request is open, the work " +
      "isn't merged, or the worktree has uncommitted changes, unless force is true. Steps already done by hand are " +
      "reported as 'already gone', so it's safe to re-run. Use dryRun first to preview.",
    inputSchema: {
      ref: z.string().describe("Session id or ticket id"),
      force: z.boolean().optional(),
      keepRemote: z.boolean().optional().describe("Don't delete the remote branch"),
      keepTab: z.boolean().optional().describe("Leave the cmux tab open"),
      summary: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ ref, ...opts }) => jsonResult(await closeTicket(ref, opts)),
);

server.registerTool(
  "delegaitor_ticket_move",
  {
    title: "Move a delegated ticket on its board",
    description:
      "Moves a delegated ticket's source item (Notion/Linear/Jira) to the board status configured for a lifecycle " +
      "stage at dispatch time. Normally happens automatically on dispatch and delegaitor_session_complete; use " +
      "this to retry after a failed move.",
    inputSchema: { ticketId: z.string(), stage: z.enum(BOARD_LIFECYCLE) },
  },
  async ({ ticketId, stage }) => {
    const result = await syncBoardStatus(ticketId, stage);
    return result
      ? jsonResult(result)
      : textResult(`No board status configured for "${stage}" on ticket ${ticketId}.`);
  },
);

server.registerTool(
  "delegaitor_session_cleanup",
  {
    title: "Clean up a finished session",
    description:
      "Closes the session's cmux workspace (if any) and safely tears down its worktree/branch. Nothing " +
      "destructive happens by default: removeWorktree='if-clean' only removes a worktree with no uncommitted " +
      "changes, deleteBranch='if-merged' only deletes a branch already merged into its base ref. Use 'force' " +
      "to override, or dryRun to preview without changing anything.",
    inputSchema: {
      sessionId: z.string(),
      removeWorktree: CleanupModeWorktree.default("never"),
      deleteBranch: CleanupModeBranch.default("never"),
      deleteRemote: z.boolean().default(false).describe("Also delete the remote branch, subject to deleteBranch gate"),
      dryRun: z.boolean().default(false).describe("Report what would happen without changing anything"),
    },
  },
  async ({ sessionId, removeWorktree, deleteBranch, deleteRemote, dryRun }) => {
    const report = await cleanupSession(sessionId, { removeWorktree, deleteBranch, deleteRemote, dryRun });
    return jsonResult(report);
  },
);

server.registerTool(
  "delegaitor_cleanup",
  {
    title: "Clean up all finished sessions",
    description:
      "Finds every finished session (completed/done/failed/cancelled) and tears down its cmux workspace, worktree, " +
      "and branch using the same safety gates as delegaitor_session_cleanup. Use dryRun first to preview.",
    inputSchema: {
      removeWorktree: CleanupModeWorktree.default("if-clean"),
      deleteBranch: CleanupModeBranch.default("if-merged"),
      deleteRemote: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ removeWorktree, deleteBranch, deleteRemote, dryRun }) => {
    const candidates = listCleanupCandidates({ onlyFinished: true });
    const reports = [];
    for (const c of candidates) {
      reports.push(await cleanupSession(c.sessionId, { removeWorktree, deleteBranch, deleteRemote, dryRun }));
    }
    return jsonResult({ candidateCount: candidates.length, reports });
  },
);

function repoIdForTicket(ticketId: string): string {
  const row = getDb().prepare(`SELECT repo_id as repoId FROM tickets WHERE id = ?`).get(ticketId) as
    | { repoId: string }
    | undefined;
  if (!row) throw new Error(`Unknown ticket id: ${ticketId}`);
  return row.repoId;
}

const transport = new StdioServerTransport();
await server.connect(transport);
