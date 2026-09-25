#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  dispatchTicket,
  persistPlan,
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
  notifyCmux,
  getDb,
  type AgentRuntimeKind,
  type ExecutionPlan,
  type CleanupReport,
} from "@delegaitor/core";

const program = new Command();
program.name("delegaitor").description("Delegates tickets to isolated worktrees/branches and agent sessions.");

program
  .command("plan")
  .description("Resolve tickets from input and print an execution plan without dispatching")
  .argument("[text]", "ticket text: issue refs (#123), markdown list, or explicit ticket titles/ids/URLs")
  .option("-f, --file <path>", "read ticket text from a file instead of the argument")
  .option("--agent <runtime>", "default agent runtime: claude, copilot, codex, opencode", "claude")
  .option("--repo <owner/repo>", "default repo for #123-style refs and markdown tickets")
  .option("--repo-path <path>", "local path of --repo (defaults to cwd)")
  .option("--base <ref>", "default base branch", "main")
  .option("--all", "pull every ticket on shared boards (Notion/Linear/Jira), not just those assigned to you", false)
  .option("--github-mine", "also pull open GitHub issues assigned to you in --repo", false)
  .option("--notion-db <id>", "Notion database id to also pull tickets from")
  .option("--linear", "also pull tickets from Linear (uses LINEAR_API_KEY)", false)
  .option("--linear-team <key>", "restrict Linear to one team key, e.g. ENG")
  .option("--jira-project <key>", "pull tickets from this Jira project (uses JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)")
  .option("--jira-jql <jql>", "custom JQL, overrides the default mine/project query")
  .action(async (text, opts) => {
    const rawInput = await readInput(text, opts.file);
    const plan = await resolvePlan(rawInput, opts);
    printPlan(plan);
  });

program
  .command("dispatch")
  .description("Resolve tickets, create worktrees/branches, and launch an agent session per ticket")
  .argument("[text]", "ticket text: issue refs (#123), markdown list, or explicit ticket titles/ids/URLs")
  .option("-f, --file <path>", "read ticket text from a file instead of the argument")
  .option("--agent <runtime>", "default agent runtime: claude, copilot, codex, opencode", "claude")
  .option("--repo <owner/repo>", "default repo for #123-style refs and markdown tickets")
  .option("--repo-path <path>", "local path of --repo (defaults to cwd)")
  .option("--base <ref>", "default base branch", "main")
  .option("--all", "pull every ticket on shared boards (Notion/Linear/Jira), not just those assigned to you", false)
  .option("--github-mine", "also pull open GitHub issues assigned to you in --repo", false)
  .option("--notion-db <id>", "Notion database id to also pull tickets from")
  .option("--linear", "also pull tickets from Linear (uses LINEAR_API_KEY)", false)
  .option("--linear-team <key>", "restrict Linear to one team key, e.g. ENG")
  .option("--jira-project <key>", "pull tickets from this Jira project (uses JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)")
  .option("--jira-jql <jql>", "custom JQL, overrides the default mine/project query")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (text, opts) => {
    const rawInput = await readInput(text, opts.file);
    const plan = await resolvePlan(rawInput, opts);
    printPlan(plan);
    if (!plan.tickets.length) return;

    if (!opts.yes) {
      const proceed = await confirm(`Dispatch ${plan.tickets.length} ticket(s)? [y/N] `);
      if (!proceed) {
        console.log("Aborted.");
        return;
      }
    }

    persistPlan(plan, rawInput);
    for (const ticket of plan.tickets) {
      process.stdout.write(`Dispatching ${ticket.id} (${ticket.agent})... `);
      try {
        const result = await dispatchTicket(plan, ticket);
        console.log(
          `${result.launch.method}${result.launch.cmuxWorkspaceId ? ` [${result.launch.cmuxWorkspaceId}]` : ""} ` +
            `session=${result.sessionId}`,
        );
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await notifyCmux("delegAItor", `Dispatched ${plan.tickets.length} ticket(s)`);
  });

program
  .command("status")
  .description("Show tickets and their session status")
  .option("--ticket <id>", "filter to one ticket id")
  .action((opts) => {
    const rows = getDb()
      .prepare(
        `SELECT id, title, repo_id as repoId, status FROM tickets ${opts.ticket ? "WHERE id = ?" : ""} ORDER BY created_at DESC`,
      )
      .all(...(opts.ticket ? [opts.ticket] : [])) as { id: string; title: string; repoId: string; status: string }[];
    for (const t of rows) {
      console.log(`\n${t.id}  [${t.status}]  ${t.title}  (${t.repoId})`);
      for (const s of listSessions({ ticketId: t.id })) {
        console.log(
          `  session ${s.id}  agent=${s.agent}  branch=${s.branch}  status=${s.status}` +
            (s.cmuxWorkspaceId ? `  cmux=${s.cmuxWorkspaceId}` : ""),
        );
      }
    }
    if (!rows.length) console.log("No tickets found.");
  });

const lock = program.command("lock").description("Advisory resource locks between concurrent sessions");
lock
  .command("acquire")
  .requiredOption("--session <id>")
  .requiredOption("--ticket <id>")
  .requiredOption("--resource <name>")
  .option("--repo <id>", "defaults to the ticket's repo")
  .action((opts) => {
    const repoId = opts.repo ?? repoIdForTicket(opts.ticket);
    const res = acquireLock({ repoId, resource: opts.resource, ticketId: opts.ticket, sessionId: opts.session });
    if (res.ok) {
      console.log(`OK: lock ${res.lockId} acquired on "${opts.resource}"`);
    } else {
      console.log(
        `HELD: "${opts.resource}" is locked by session ${res.heldBy.sessionId} (ticket ${res.heldBy.ticketId}) ` +
          `since ${res.heldBy.acquiredAt}`,
      );
      process.exitCode = 1;
    }
  });
lock
  .command("release")
  .requiredOption("--session <id>")
  .requiredOption("--resource <name>")
  .action((opts) => {
    releaseLock(opts.session, opts.resource);
    console.log(`OK: released "${opts.resource}"`);
  });
lock
  .command("list")
  .option("--repo <id>")
  .action((opts) => {
    for (const l of listActiveLocks(opts.repo)) {
      console.log(`${l.resource}  ticket=${l.ticketId}  session=${l.sessionId}  since=${l.acquiredAt}`);
    }
  });

const message = program.command("message").description("Inter-session messaging for tickets that overlap");
message
  .command("send")
  .requiredOption("--session <id>", "sender session id")
  .option("--to-ticket <id>", "broadcast to all sessions on this ticket")
  .option("--to-session <id>", "send to one specific session")
  .requiredOption("--body <text>")
  .option("--kind <kind>", "note|conflict|question|answer|blocked|done", "note")
  .action((opts) => {
    const id = sendMessage({
      fromSessionId: opts.session,
      toTicketId: opts.toTicket,
      toSessionId: opts.toSession,
      body: opts.body,
      kind: opts.kind,
    });
    console.log(`OK: message ${id} sent`);
  });
message
  .command("inbox")
  .option("--ticket <id>")
  .option("--session <id>")
  .option("--mark-read", "mark returned messages as read", false)
  .action((opts) => {
    const msgs = unreadMessagesFor({ ticketId: opts.ticket, sessionId: opts.session });
    for (const m of msgs) {
      console.log(`[${m.kind}] (#${m.id} from ${m.fromSessionId} at ${m.createdAt}) ${m.body}`);
      if (opts.markRead) markRead(m.id);
    }
    if (!msgs.length) console.log("No unread messages.");
  });

const session = program.command("session").description("Manage agent sessions");
session
  .command("complete")
  .requiredOption("--session <id>")
  .requiredOption("--status <status>", "e.g. ready_for_review, blocked, done")
  .option("--summary <text>")
  .action(async (opts) => {
    completeSession(opts.session, opts.status, opts.summary);
    await notifyCmux("delegAItor", `Session ${opts.session}: ${opts.status}${opts.summary ? ` — ${opts.summary}` : ""}`);
    console.log("OK");
  });
session
  .command("cleanup")
  .description("Tear down one finished session's resources (cmux tab, worktree, branch)")
  .requiredOption("--session <id>")
  .option("--remove-worktree <mode>", "never|if-clean|force", "never")
  .option("--delete-branch <mode>", "never|if-merged|force", "never")
  .option("--delete-remote", "also delete the remote branch (subject to --delete-branch gate)", false)
  .option("--dry-run", "report what would happen without changing anything", false)
  .action(async (opts) => {
    const report = await cleanupSession(opts.session, {
      removeWorktree: opts.removeWorktree,
      deleteBranch: opts.deleteBranch,
      deleteRemote: opts.deleteRemote,
      dryRun: opts.dryRun,
    });
    printCleanupReport(report);
  });

program
  .command("cleanup")
  .description("Clean up all finished sessions' resources (cmux tabs, worktrees, branches)")
  .option("--remove-worktree <mode>", "never|if-clean|force", "if-clean")
  .option("--delete-branch <mode>", "never|if-merged|force", "if-merged")
  .option("--delete-remote", "also delete remote branches (subject to --delete-branch gate)", false)
  .option("--dry-run", "report what would happen without changing anything", false)
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (opts) => {
    const candidates = listCleanupCandidates({ onlyFinished: true });
    if (!candidates.length) {
      console.log("No finished sessions to clean up.");
      return;
    }
    console.log(`Found ${candidates.length} finished session(s):`);
    for (const c of candidates) {
      console.log(`  ${c.sessionId}  ticket=${c.ticketId} (${c.ticketTitle})  branch=${c.branch}  status=${c.status}`);
    }
    if (!opts.dryRun && !opts.yes) {
      const proceed = await confirm(`Clean up ${candidates.length} session(s)? [y/N] `);
      if (!proceed) {
        console.log("Aborted.");
        return;
      }
    }
    for (const c of candidates) {
      const report = await cleanupSession(c.sessionId, {
        removeWorktree: opts.removeWorktree,
        deleteBranch: opts.deleteBranch,
        deleteRemote: opts.deleteRemote,
        dryRun: opts.dryRun,
      });
      printCleanupReport(report);
    }
  });

program.parseAsync(process.argv);

// --- helpers -----------------------------------------------------------

async function readInput(text: string | undefined, file: string | undefined): Promise<string> {
  const input = text ?? (file ? readFileSync(file, "utf8") : await readStdinIfPiped()) ?? "";
  if (!input.trim()) {
    console.error("No ticket text provided (pass an argument, --file, or pipe via stdin).");
    process.exit(1);
  }
  return input;
}

async function resolvePlan(
  input: string,
  opts: {
    agent: string;
    repo?: string;
    repoPath?: string;
    base: string;
    all?: boolean;
    githubMine?: boolean;
    notionDb?: string;
    linear?: boolean;
    linearTeam?: string;
    jiraProject?: string;
    jiraJql?: string;
  },
): Promise<ExecutionPlan> {
  return resolveExecutionPlan(input, {
    defaultAgent: opts.agent as AgentRuntimeKind,
    repo: opts.repo,
    repoPath: opts.repoPath,
    base: opts.base,
    all: opts.all,
    github: { mine: opts.githubMine },
    notion: opts.notionDb ? { databaseId: opts.notionDb } : undefined,
    linear: opts.linear ? { teamKey: opts.linearTeam } : undefined,
    jira: opts.jiraProject || opts.jiraJql ? { project: opts.jiraProject, jql: opts.jiraJql } : undefined,
  });
}

function repoIdForTicket(ticketId: string): string {
  const row = getDb().prepare(`SELECT repo_id as repoId FROM tickets WHERE id = ?`).get(ticketId) as
    | { repoId: string }
    | undefined;
  if (!row) {
    console.error(`Unknown ticket id: ${ticketId}`);
    process.exit(1);
  }
  return row.repoId;
}

function printPlan(plan: ExecutionPlan): void {
  if (!plan.tickets.length) {
    console.log("No tickets resolved from input.");
    return;
  }
  console.log(`Run ${plan.runId}\n`);
  for (const t of plan.tickets) {
    console.log(
      `${t.id}  [${t.agent}]  ${t.title}\n` +
        `  repo=${t.repoId}  branch=${t.branch}  base=${t.baseRef}\n` +
        (t.dependsOn?.length ? `  depends_on=${t.dependsOn.join(",")}\n` : "") +
        (t.conflictsWith.length ? `  ⚠ possible conflict with: ${t.conflictsWith.join(", ")}\n` : ""),
    );
  }
}

function printCleanupReport(report: CleanupReport): void {
  const prefix = report.dryRun ? "[dry-run] " : "";
  console.log(`${prefix}session ${report.sessionId}  ticket=${report.ticketId}  branch=${report.branch}`);
  console.log(`  worktree ${report.worktreePath}`);
  console.log(`  cmux workspace: ${report.closedWorkspace ? "closed" : "left open (none tracked, or skipped)"}`);
  console.log(
    report.worktreeRemoved
      ? "  worktree: removed"
      : `  worktree: kept${report.worktreeSkippedReason ? ` (${report.worktreeSkippedReason})` : ""}`,
  );
  console.log(
    report.branchDeleted
      ? `  branch: deleted${report.remoteBranchDeleted ? " (local + remote)" : " (local only)"}`
      : `  branch: kept${report.branchSkippedReason ? ` (${report.branchSkippedReason})` : ""}`,
  );
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim().toLowerCase().startsWith("y"));
    });
  });
}

async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
