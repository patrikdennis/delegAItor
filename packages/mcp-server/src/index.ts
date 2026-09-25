#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  persistPlan,
  dispatchTicket,
  listSessions,
  completeSession,
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
  type ExecutionPlan,
  type AgentRuntimeKind,
} from "@delegaitor/core";

const server = new McpServer({ name: "delegaitor", version: "0.1.0" });

const AgentEnum = z.enum(["claude", "copilot", "codex", "opencode"]);
const CleanupModeWorktree = z.enum(["never", "if-clean", "force"]);
const CleanupModeBranch = z.enum(["never", "if-merged", "force"]);

/** Shared ticket-source input fields for delegaitor_plan and delegaitor_dispatch. */
const ticketSourceInputSchema = {
  text: z.string().describe("Ticket references or a markdown-style ticket list"),
  agent: AgentEnum.default("claude").describe("Default agent runtime to assign to each ticket"),
  repo: z.string().optional().describe('Default repo as "owner/repo"'),
  repoPath: z.string().optional().describe("Local filesystem path of --repo; defaults to cwd"),
  base: z.string().optional().describe("Default base branch, defaults to main"),
  all: z
    .boolean()
    .default(false)
    .describe(
      "Pull every ticket on shared boards (Notion/Linear/Jira), not just those assigned to you. " +
        "Explicit ticket titles/ids/URLs in `text` always override this filter.",
    ),
  githubMine: z.boolean().default(false).describe("Also pull open GitHub issues assigned to you in `repo`"),
  notionDatabaseId: z.string().optional().describe("Notion database id to also pull tickets from"),
  notionAssigneeId: z
    .string()
    .optional()
    .describe(
      "Your Notion user id. Only needed for shared/workspace-owned Notion integration tokens, where " +
        "delegAItor can't auto-detect which teammate is running it.",
    ),
  linear: z.boolean().default(false).describe("Also pull tickets from Linear (uses LINEAR_API_KEY)"),
  linearTeamKey: z.string().optional().describe("Restrict Linear to one team key, e.g. ENG"),
  jiraProject: z
    .string()
    .optional()
    .describe("Pull tickets from this Jira project (uses JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)"),
  jiraJql: z.string().optional().describe("Custom JQL, overrides the default mine/project query"),
};

async function resolvePlan(args: {
  text: string;
  agent: AgentRuntimeKind;
  repo?: string;
  repoPath?: string;
  base?: string;
  all?: boolean;
  githubMine?: boolean;
  notionDatabaseId?: string;
  notionAssigneeId?: string;
  linear?: boolean;
  linearTeamKey?: string;
  jiraProject?: string;
  jiraJql?: string;
}): Promise<ExecutionPlan> {
  return resolveExecutionPlan(args.text, {
    defaultAgent: args.agent,
    repo: args.repo,
    repoPath: args.repoPath,
    base: args.base,
    all: args.all,
    github: { mine: args.githubMine },
    notion: args.notionDatabaseId
      ? { databaseId: args.notionDatabaseId, assigneeUserId: args.notionAssigneeId }
      : undefined,
    linear: args.linear ? { teamKey: args.linearTeamKey } : undefined,
    jira: args.jiraProject || args.jiraJql ? { project: args.jiraProject, jql: args.jiraJql } : undefined,
  });
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
    persistPlan(plan, args.text);

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
        });
      } catch (err) {
        results.push({ ticketId: ticket.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return jsonResult({ runId: plan.runId, tickets: results });
  },
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
      "it still holds so other sessions can proceed.",
    inputSchema: { sessionId: z.string(), status: z.string(), summary: z.string().optional() },
  },
  async ({ sessionId, status, summary }) => {
    completeSession(sessionId, status, summary);
    return textResult(`Session ${sessionId} marked ${status}`);
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
      "Finds every finished session (completed/failed/cancelled) and tears down its cmux workspace, worktree, " +
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
