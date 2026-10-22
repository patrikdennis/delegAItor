#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  dispatchTicket,
  persistPlan,
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
  notifyCmux,
  markWorkUnitFailed,
  getDb,
  syncBoardStatus,
  isBoardLifecycle,
  BOARD_LIFECYCLE,
  CREDENTIAL_NAMES,
  isCredentialName,
  setCredential,
  removeCredential,
  listCredentials,
  credentialsPath,
  getProfile,
  mergeProfile,
  cleanProfile,
  profileToResolveOptions,
  profileHasTicketSource,
  repoIdForSession,
  saveProfile,
  listProfiles,
  removeProfile,
  profilesPath,
  primaryTickets,
  type DispatchProfile,
  type BoardStatusResult,
  type AgentRuntimeKind,
  type ExecutionPlan,
  type CleanupReport,
  type RepoCatalogEntry,
} from "@delegaitor/core";

const program = new Command();
program.name("delegaitor").description("Delegates tickets to isolated worktrees/branches and agent sessions.");

addPlanOptions(
  program
    .command("plan")
    .description("Resolve tickets from input and print an execution plan without dispatching")
    .argument("[text]", "ticket text: issue refs (#123), markdown list, or explicit ticket titles/ids/URLs")
    .option("-f, --file <path>", "read ticket text from a file instead of the argument")
    .option("--profile <name>", "use a saved profile (see `delegaitor profile`); flags you pass override it"),
).action(async (text, opts) => {
  ensureRepositoryProfile(opts);
  const profile = planProfile(opts);
  const rawInput = await readInput(text, opts.file, profile);
  const plan = await resolveExecutionPlan(rawInput, profileToResolveOptions(profile));
  printPlan(plan);
});

addPlanOptions(
  program
    .command("dispatch")
    .description("Resolve tickets, create worktrees/branches, and launch an agent session per ticket")
    .argument("[text]", "ticket text: issue refs (#123), markdown list, or explicit ticket titles/ids/URLs")
    .option("-f, --file <path>", "read ticket text from a file instead of the argument")
    .option("--profile <name>", "use a saved profile (see `delegaitor profile`); flags you pass override it")
    .option("-y, --yes", "skip confirmation prompt"),
).action(async (text, opts) => {
  ensureRepositoryProfile(opts);
  const profile = planProfile(opts);
  const rawInput = await readInput(text, opts.file, profile);
  const plan = await resolveExecutionPlan(rawInput, profileToResolveOptions(profile));
  printPlan(plan);
  if (!plan.tickets.length) return;

  if (!opts.yes) {
    const proceed = await confirm(`Dispatch ${primaryTickets(plan).length} ticket(s)? [y/N] `);
    if (!proceed) {
      console.log("Aborted.");
      return;
    }
  }

  persistPlan(plan, rawInput);
  let failedCount = 0;
  for (const ticket of primaryTickets(plan)) {
    process.stdout.write(`Dispatching ${ticket.id} (${ticket.agent})... `);
    try {
      const result = await dispatchTicket(plan, ticket);
      console.log(
        `${result.launch.method}${result.launch.cmuxWorkspaceId ? ` [${result.launch.cmuxWorkspaceId}]` : ""} ` +
          `session=${result.sessionId}` +
          (result.worktrees.length > 1 ? ` repos=${result.worktrees.map((unit) => unit.repoAlias).join(",")}` : ""),
      );
      printBoardStatus(result.boardStatus);
    } catch (err) {
      failedCount++;
      markWorkUnitFailed(ticket.id);
      console.log(`FAILED [${ticket.repoAlias ?? ticket.repoId}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ticketCount = primaryTickets(plan).length;
  await notifyCmux("delegAItor", `Dispatched ${ticketCount - failedCount}/${ticketCount} ticket(s)`);
  if (failedCount) {
    console.error(`${failedCount} ticket session(s) failed to dispatch.`);
    process.exitCode = 1;
  }
});

program
  .command("overview")
  .description("What each open ticket needs next: unblock, ship, review, or close (with PR state from gh)")
  .option("--all", "include finished tickets", false)
  .option("--no-prs", "skip looking up pull requests (faster, works offline)")
  .option("--json", "print as JSON", false)
  .action(async (opts) => {
    const items = await ticketOverview({ includeFinished: opts.all, pullRequests: opts.prs });
    if (opts.json) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log("No open tickets.");
    for (const i of items) {
      console.log(`\n${i.next.toUpperCase().padEnd(15)} ${i.title}`);
      console.log(`  ${i.nextHint}`);
      console.log(
        `  ticket ${i.ticketId}  session ${i.sessionId} [${i.sessionStatus}]  branch ${i.branch}` +
          (i.cmuxWorkspaceId ? `  ${i.cmuxWorkspaceId}` : ""),
      );
      if (i.pullRequest) console.log(`  PR #${i.pullRequest.number} ${i.pullRequest.state.toLowerCase()}: ${i.pullRequest.url}`);
      for (const unit of i.units) {
        console.log(
          `  repo ${unit.repoAlias} (${unit.repoId})  ${unit.sessionId ? `session ${unit.sessionId}` : "not started"} [${unit.status}]  branch ${unit.branch}` +
          (unit.pullRequest ? `  PR #${unit.pullRequest.number} ${unit.pullRequest.state.toLowerCase()}` : "") +
          (unit.summary ? `\n    summary: ${unit.summary}` : ""),
        );
      }
      if (i.summary) console.log(`  summary: ${i.summary}`);
      if (i.locks.length) console.log(`  holding locks: ${i.locks.join(", ")}`);
      for (const m of i.unreadMessages) console.log(`  unread [${m.kind}] from ${m.fromSessionId}: ${m.body}`);
    }
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
      console.log(`\n${t.id}  [${t.status}]  ${t.title}${t.repoId ? `  (${t.repoId})` : ""}`);
      const units = getDb()
        .prepare(
          `SELECT repo_alias as repoAlias, repo_id as repoId, status, branch, worktree_path as worktreePath
           FROM ticket_units WHERE ticket_id = ? AND active = 1 ORDER BY repo_alias`,
        )
        .all(t.id) as { repoAlias: string; repoId: string; status: string; branch: string; worktreePath: string }[];
      for (const unit of units) {
        console.log(`  work unit ${unit.repoAlias} (${unit.repoId}) [${unit.status}]  branch=${unit.branch}`);
      }
      for (const s of listSessions({ ticketId: t.id })) {
        console.log(
          `  ${s.repoAlias}  ${s.repoId}  session ${s.id}  agent=${s.agent}  branch=${s.branch}  status=${s.status}` +
            (s.cmuxWorkspaceId ? `  cmux=${s.cmuxWorkspaceId}` : ""),
        );
      }
    }
    if (!rows.length) console.log("No tickets found.");
  });

const profileCmd = program
  .command("profile")
  .description("Saved plan/dispatch options, so you can run e.g. `delegaitor dispatch --profile my-board`");
addPlanOptions(
  profileCmd
    .command("save")
    .description(
      "Save the given flags as a profile. Without --merge this replaces the profile; with it, only the flags " +
        "you pass change, and --repository adds or replaces one catalog entry by alias. A repo without " +
        "--repo-path gets the current directory.",
    )
    .argument("<name>")
    .option("--description <text>", "what this profile is for, shown in `profile list`")
    .option("--merge", "update an existing profile instead of replacing it")
    .option("--remove-repository <alias>", "drop a repository from the catalog (repeatable; implies --merge)", appendOption, []),
).action((name, opts) => {
  try {
    const removeRepos: string[] = opts.removeRepository ?? [];
    const saved = saveProfile(name, { ...cliProfile(opts), description: opts.description }, {
      merge: opts.merge || removeRepos.length > 0,
      removeRepositories: removeRepos,
    });
    console.log(`Saved profile "${name}" to ${profilesPath()}:`);
    console.log(JSON.stringify(saved, null, 2));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
});
profileCmd
  .command("list")
  .action(() => {
    const all = listProfiles();
    const names = Object.keys(all);
    if (!names.length) console.log("No profiles yet. Create one with `delegaitor profile save <name> <flags>`.");
    for (const n of names) console.log(`${n.padEnd(20)} ${all[n].description ?? ""}`);
  });
profileCmd
  .command("show")
  .argument("<name>")
  .action((name) => {
    try {
      console.log(JSON.stringify(getProfile(name), null, 2));
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  });
profileCmd
  .command("remove")
  .argument("<name>")
  .action((name) => {
    console.log(removeProfile(name) ? `Removed profile "${name}".` : `No profile named "${name}".`);
  });

const lock = program.command("lock").description("Advisory resource locks between concurrent sessions");
lock
  .command("acquire")
  .requiredOption("--session <id>")
  .requiredOption("--ticket <id>")
  .requiredOption("--resource <name>")
  .option("--repo <id>", "defaults to the ticket's repo")
  .action((opts) => {
    const repoId = opts.repo ?? repoIdForSession(opts.session);
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

const ticket = program.command("ticket").description("Manage delegated tickets");
ticket
  .command("ship")
  .description(
    "Push a ticket's branch and open a pull request linking the ticket (or reuse the open one), then mark it " +
      "ready_for_review so the board card moves. Refuses with uncommitted changes. Never force-pushes.",
  )
  .argument("<ref>", "session id, ticket id, or branch name")
  .option("--title <text>", "PR title (default: the ticket title)")
  .option("--body <text>", "PR description (default: the commit list); a link to the ticket is always added")
  .option("--draft", "open the PR as a draft", false)
  .option("--no-mark-ready", "don't mark the session ready_for_review")
  .option("--dry-run", "report what would happen without pushing or opening a PR", false)
  .action(async (ref, opts) => {
    const r = await shipTicket(ref, {
      title: opts.title,
      body: opts.body,
      draft: opts.draft,
      markReady: opts.markReady,
      dryRun: opts.dryRun,
    }).catch(fail);
    console.log(`${r.dryRun ? "[dry-run] " : ""}ticket ${r.ticketId}  session ${r.sessionId}`);
    if (r.units) {
      for (const unit of r.units) {
        console.log(`  ${unit.repoAlias} (${unit.repoId}) [${unit.status}]  branch ${unit.branch}`);
        console.log(`    push: ${unit.push}`);
        console.log(`    ${unit.commits.length} commit(s): ${unit.commits.join("; ") || "(none)"}`);
        if (unit.pullRequest) console.log(`    PR #${unit.pullRequest.number} ${unit.pullRequest.created ? "opened" : "already open"}: ${unit.pullRequest.url}`);
        if (unit.error) console.log(`    error: ${unit.error}`);
      }
    } else {
      console.log(`  branch ${r.branch} -> ${r.baseRef}`);
      console.log(`  ${r.commits.length} commit(s): ${r.commits.join("; ")}`);
      console.log(`  push: ${r.pushed}`);
      if (r.pullRequest) {
        console.log(`  PR #${r.pullRequest.number} ${r.pullRequest.created ? "opened" : "already open"}: ${r.pullRequest.url}`);
      } else if (r.pullRequestError) {
        console.log(`  PR: could not open: ${r.pullRequestError}`);
      }
    }
    for (const w of r.warnings) console.log(`  warning: ${w}`);
    printBoardStatus(r.boardStatus);
    if (r.parentStatus) console.log(`Parent ticket status: ${r.parentStatus}`);
    if (r.pullRequestError) process.exitCode = 1;
    if (r.parentStatus && r.parentStatus !== "ready_for_review") {
      console.log(`  parent ticket remains ${r.parentStatus} until every changed repo has a PR`);
    }
    if (r.units?.some((unit) => unit.status === "failed")) process.exitCode = 1;
  });
ticket
  .command("context")
  .description("Print a ticket's text, commits and diff against its base branch, e.g. to review it")
  .argument("<ref>", "session id, ticket id, or branch name")
  .option("--no-diff", "leave out the full diff (keeps the diffstat)")
  .option("--json", "print as JSON", false)
  .action(async (ref, opts) => {
    const c = await ticketContext(ref, { diff: opts.diff }).catch(fail);
    if (opts.json) return console.log(JSON.stringify(c, null, 2));
    console.log(`# ${c.title}\n${c.externalUrl ?? ""}\n\n${c.body ?? "(no ticket body)"}\n`);
    console.log(`Branch ${c.branch} -> ${c.baseRef}   session ${c.sessionId} [${c.sessionStatus}]`);
    if (c.pullRequest) console.log(`PR #${c.pullRequest.number} ${c.pullRequest.state}: ${c.pullRequest.url}`);
    if (c.summary) console.log(`Agent summary: ${c.summary}`);
    console.log(`\nCommits:\n${c.commits.map((l) => `  ${l}`).join("\n") || "  (none)"}`);
    if (c.uncommitted.length) console.log(`\nUncommitted:\n${c.uncommitted.map((l) => `  ${l}`).join("\n")}`);
    console.log(`\n${c.diffStat}`);
    if (c.diff) console.log(`\n${c.diff}${c.diffTruncated ? "\n... (diff truncated)" : ""}`);
  });
ticket
  .command("close")
  .description(
    "Close a finished ticket: remove its worktree, delete the local and remote branch, mark the session done, " +
      "move the board card to done, and close its cmux tab. Refuses if the work isn't merged unless --force.",
  )
  .argument("<ref>", "session id or ticket id")
  .option("--force", "close even if not merged or the worktree has uncommitted changes", false)
  .option("--keep-remote", "don't delete the remote branch", false)
  .option("--keep-tab", "leave the cmux tab open", false)
  .option("--summary <text>", "session summary (default: \"Merged as PR #N\" when a merged PR is found)")
  .option("--dry-run", "report what would happen without changing anything", false)
  .action(async (ref, opts) => {
    const report = await closeTicket(ref, {
      force: opts.force,
      keepRemote: opts.keepRemote,
      keepTab: opts.keepTab,
      summary: opts.summary,
      dryRun: opts.dryRun,
    }).catch((e: Error) => {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    });
    const pr = report.pullRequest;
    console.log(
      `${report.dryRun ? "[dry-run] " : ""}ticket ${report.ticketId}  session ${report.sessionId}` +
        (pr ? `  PR #${pr.number} ${pr.state.toLowerCase()}` : ""),
    );
    for (const st of report.steps) {
      console.log(`  ${st.step.padEnd(22)} ${st.result}${st.detail ? `  (${st.detail})` : ""}`);
    }
    for (const unit of report.units ?? []) {
      console.log(`  repo ${unit.repoAlias} (${unit.repoId}) [${unit.status}] branch=${unit.branch}` +
        (unit.pullRequest ? ` PR #${unit.pullRequest.number} ${unit.pullRequest.state.toLowerCase()}` : "") +
        (unit.error ? ` error=${unit.error}` : ""));
    }
    printBoardStatus(report.boardStatus);
    if (report.parentStatus) {
      console.log(`Parent ticket status: ${report.parentStatus}`);
      if (report.parentStatus !== "done") console.log("  parent remains open until all required PRs are merged and cleanup succeeds");
    }
    if (report.steps.some((step) => step.result === "failed") || report.units?.some((unit) => unit.status === "failed")) process.exitCode = 1;
  });
ticket
  .command("move")
  .description("Move a delegated ticket on its board to the status configured for a lifecycle stage (e.g. to retry a failed update)")
  .requiredOption("--ticket <id>")
  .requiredOption("--stage <stage>", BOARD_LIFECYCLE.join("|"))
  .action(async (opts) => {
    if (!isBoardLifecycle(opts.stage)) {
      console.error(`Unknown stage "${opts.stage}". Expected one of: ${BOARD_LIFECYCLE.join(", ")}`);
      process.exit(1);
    }
    const result = await syncBoardStatus(opts.ticket, opts.stage);
    if (!result) {
      console.log(`Nothing to do: no board status configured for "${opts.stage}" on ticket ${opts.ticket} (pass --move-on-* at dispatch).`);
      return;
    }
    printBoardStatus(result);
    if (!result.ok) process.exitCode = 1;
  });

const auth = program
  .command("auth")
  .description(`Store ticket-source credentials in ${"$DELEGAITOR_HOME"}/credentials.json so agent sessions can use them too`);
auth
  .command("set")
  .argument("<name>", CREDENTIAL_NAMES.join("|"))
  .description("Store a credential (value read from stdin or a hidden prompt, never from argv)")
  .action(async (name: string) => {
    if (!isCredentialName(name)) {
      console.error(`Unknown credential "${name}". Expected one of: ${CREDENTIAL_NAMES.join(", ")}`);
      process.exit(1);
    }
    const value = (process.stdin.isTTY ? await promptHidden(`${name}: `) : await readStdinIfPiped())?.trim();
    if (!value) {
      console.error("No value provided.");
      process.exit(1);
    }
    setCredential(name, value);
    console.log(`OK: stored ${name} in ${credentialsPath()} (mode 600)`);
  });
auth
  .command("remove")
  .argument("<name>", CREDENTIAL_NAMES.join("|"))
  .action((name: string) => {
    if (!isCredentialName(name)) {
      console.error(`Unknown credential "${name}".`);
      process.exit(1);
    }
    console.log(removeCredential(name) ? `OK: removed ${name}` : `${name} was not stored.`);
  });
auth
  .command("list")
  .description("Show which credentials are available and where from (values are never printed)")
  .action(() => {
    for (const c of listCredentials()) {
      console.log(`${c.name.padEnd(16)} ${c.source ?? "-"}`);
    }
  });

const session = program.command("session").description("Manage agent sessions");
session
  .command("complete")
  .requiredOption("--session <id>")
  .requiredOption("--status <status>", "e.g. ready_for_review, blocked, done")
  .option("--summary <text>")
  .action(async (opts) => {
    const result = await completeSession(opts.session, opts.status, opts.summary);
    printBoardStatus(result.boardStatus);
    if (result.parentStatus) console.log(`Parent ticket status: ${result.parentStatus}`);
    await notifyCmux("delegAItor", `Session ${opts.session}: ${opts.status}${opts.summary ? ` — ${opts.summary}` : ""}`);
    console.log("OK");
  });
session
  .command("screen")
  .description("Print the last lines of a session's cmux tab, e.g. to see what a blocked agent asked")
  .argument("<ref>", "session id, ticket id, or branch name")
  .option("--lines <n>", "number of lines", "80")
  .action(async (ref, opts) => {
    console.log(await readSessionScreen(ref, Number(opts.lines)).catch(fail));
  });
session
  .command("nudge")
  .description("Type a reply into a session's agent prompt (in its cmux tab) and press Enter; resumes a blocked session")
  .argument("<ref>", "session id, ticket id, or branch name")
  .argument("<text...>", "what to tell the agent")
  .option("--no-resume", "don't mark a blocked session running again")
  .action(async (ref, text: string[], opts) => {
    const r = await nudgeSession(ref, text.join(" "), { resume: opts.resume }).catch(fail);
    console.log(`Sent to session ${r.sessionId}${r.resumed ? " (resumed from blocked)" : ""}.`);
    if (r.parentStatus) console.log(`Parent ticket status: ${r.parentStatus}`);
    printBoardStatus(r.boardStatus);
  });
session
  .command("rename-branch")
  .description("Swap the prefix of a session's branch (e.g. feature/ -> fix/) before it's pushed")
  .requiredOption("--session <id>")
  .requiredOption("--prefix <prefix>", "e.g. fix/")
  .action(async (opts) => {
    const r = await renameSessionBranch(opts.session, opts.prefix).catch((e: Error) => {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    });
    console.log(r.oldBranch === r.newBranch ? `Unchanged: ${r.newBranch}` : `Renamed ${r.oldBranch} -> ${r.newBranch}`);
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

// Any ticket-source flag lets you skip the raw-text argument entirely, since
// these pull tickets directly from an API rather than parsing #123-refs or a
// markdown list out of freeform text.

async function readInput(
  text: string | undefined,
  file: string | undefined,
  profile: DispatchProfile,
): Promise<string> {
  const input = text ?? (file ? readFileSync(file, "utf8") : await readStdinIfPiped()) ?? "";
  if (!input.trim() && !profileHasTicketSource(profile)) {
    console.error(
      "No ticket text provided (pass an argument, --file, pipe via stdin, or use a ticket-source flag " +
        "like --notion-db, --linear, --jira-project, or --github-mine)."
    );
    process.exit(1);
  }
  return input;
}

/** Every option shared by plan, dispatch and profile save. */
function addPlanOptions(cmd: Command): Command {
  return cmd
    .option("--agent <runtime>", "default agent runtime: claude, copilot, codex, opencode (default: claude)")
    .option("--repo <owner/repo>", "default repo for #123-style refs and markdown tickets")
    .option("--repo-path <path>", "local path of --repo (defaults to cwd)")
    .option(
      "--repository <alias|owner/repo|path|base>",
      "local repository catalog entry for this profile (repeatable; all four fields required)",
      appendOption,
      [],
    )
    .option("--base <ref>", "default base branch (default: main)")
    .option("--branch-prefix <prefix>", "force this prefix on every branch, e.g. \"fix/\" (\"\" for none); default: picked per ticket")
    .option("--branch-rules <file>", "branch-prefixes.json describing your team's prefixes (default: <repo>/.delegaitor/branch-prefixes.json, then ~/.delegaitor/branch-prefixes.json, then detected from the repo's branches)")
    .option("--all", "pull every ticket on shared boards (Notion/Linear/Jira), not just those assigned to you")
    .option("--github-mine", "also pull open GitHub issues assigned to you in --repo")
    .option("--github-comments", "also fetch each GitHub issue's comment thread as extra ticket context")
    .option("--notion-db <id>", "Notion database id to also pull tickets from")
    .option("--notion-assignee-id <id>", "Your Notion user id, for shared/workspace-owned integration tokens that can't auto-detect it")
    .option("--notion-assignee-prop <name>", "Notion people property containing assignees (default: Assignee)")
    .option("--notion-status <statuses>", "comma-separated Status values to delegate, exactly as they appear on your board (e.g. \"Not started,Backlog\"); default pulls every status")
    .option("--notion-project-prop <name>", "Notion property exposing a human-readable project/initiative name (e.g. a rollup surfacing a related Project relation's title), used with --notion-project")
    .option("--notion-project <names>", "comma-separated project/initiative names to delegate (requires --notion-project-prop); every board organizes projects differently, so there's no default")
    .option("--notion-title-prop <name>", "Notion title property name, if not \"Name\" (e.g. \"Task\")")
    .option("--notion-status-prop <name>", "Notion status/select property name, if not \"Status\"; used both for --notion-status filtering and --move-on-* updates")
    .option("--notion-body-prop <name>", "Notion rich-text property to use as ticket body/spec (in addition to page content), e.g. \"Spec\"")
    .option("--notion-no-page-content", "skip fetching each Notion page's body content (paragraphs/lists below the properties); only use --notion-body-prop if set")
    .option("--linear", "also pull tickets from Linear (uses LINEAR_API_KEY)")
    .option("--linear-team <key>", "restrict Linear to one team key, e.g. ENG")
    .option("--linear-status <statuses>", "comma-separated workflow state names to delegate, exactly as they appear on your team's board; default is any non-completed/canceled state")
    .option("--jira-project <key>", "pull tickets from this Jira project (uses JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)")
    .option("--jira-jql <jql>", "custom JQL, overrides the default mine/project query")
    .option("--jira-status <statuses>", "comma-separated status names to delegate, exactly as they appear on your board; default is statusCategory != Done")
    .option("--move-on-dispatch <status>", "board status to move each ticket to when its agent session starts, exactly as named on your board (e.g. \"In progress\")")
    .option("--move-on-review <status>", "board status to move a ticket to when its session completes as ready_for_review (e.g. \"Ready for review\")")
    .option("--move-on-blocked <status>", "board status to move a ticket to when its session reports blocked")
    .option("--move-on-done <status>", "board status to move a ticket to when its session completes as done");
}

type PlanCliOptions = {
  profile?: string;
  agent?: string;
  repo?: string;
  repoPath?: string;
  base?: string;
  branchPrefix?: string;
  branchRules?: string;
  all?: boolean;
  githubMine?: boolean;
  githubComments?: boolean;
  notionDb?: string;
  notionAssigneeId?: string;
  notionAssigneeProp?: string;
  notionStatus?: string;
  notionTitleProp?: string;
  notionStatusProp?: string;
  notionBodyProp?: string;
  notionProjectProp?: string;
  notionProject?: string;
  notionNoPageContent?: boolean;
  linear?: boolean;
  linearTeam?: string;
  linearStatus?: string;
  jiraProject?: string;
  jiraJql?: string;
  jiraStatus?: string;
  moveOnDispatch?: string;
  moveOnReview?: string;
  moveOnBlocked?: string;
  moveOnDone?: string;
  repository?: string[];
};

/** The flags actually passed, in profile form. Unset flags are left undefined so they don't override a profile. */
function cliProfile(opts: PlanCliOptions): DispatchProfile {
  return cleanProfile({
    agent: opts.agent,
    repo: opts.repo,
    repoPath: opts.repoPath,
    base: opts.base,
    branchPrefix: opts.branchPrefix,
    branchRules: opts.branchRules,
    repositories: opts.repository?.length ? opts.repository.map(parseRepositorySpec) : undefined,
    all: opts.all,
    githubMine: opts.githubMine,
    githubComments: opts.githubComments,
    notionDatabaseId: opts.notionDb,
    notionAssigneeId: opts.notionAssigneeId,
    notionAssigneeProp: opts.notionAssigneeProp,
    notionStatuses: parseStatusList(opts.notionStatus),
    notionTitleProp: opts.notionTitleProp,
    notionStatusProp: opts.notionStatusProp,
    notionBodyProp: opts.notionBodyProp,
    notionProjectProp: opts.notionProjectProp,
    notionProjects: parseStatusList(opts.notionProject),
    notionIncludePageContent: opts.notionNoPageContent ? false : undefined,
    linear: opts.linear,
    linearTeamKey: opts.linearTeam,
    linearStatuses: parseStatusList(opts.linearStatus),
    jiraProject: opts.jiraProject,
    jiraJql: opts.jiraJql,
    jiraStatuses: parseStatusList(opts.jiraStatus),
    boardStatuses: {
      in_progress: opts.moveOnDispatch,
      ready_for_review: opts.moveOnReview,
      blocked: opts.moveOnBlocked,
      done: opts.moveOnDone,
    },
  });
}

function planProfile(opts: PlanCliOptions): DispatchProfile {
  const flags = cliProfile(opts);
  if (!opts.profile) return flags;
  try {
    return mergeProfile(getProfile(opts.profile), flags);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

function fail(e: Error): never {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

function ensureRepositoryProfile(opts: PlanCliOptions): void {
  if (opts.repository?.length && !opts.profile) {
    throw new Error("Save repo catalogs with `delegaitor profile save <name> --repository ...`, then plan/dispatch with --profile.");
  }
}

function printBoardStatus(result: BoardStatusResult | undefined): void {
  if (!result) return;
  console.log(
    result.ok
      ? `  board: moved to "${result.status}"`
      : `  board: could not move to "${result.status}": ${result.error}`,
  );
}

/**
 * Board columns/statuses are named however each team likes ("Backlog",
 * "Not started", "To do", ...), so status filters are taken as a raw
 * comma-separated list rather than a fixed enum, e.g.
 * `--notion-status "Not started,Backlog"`.
 */
function parseStatusList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function printPlan(plan: ExecutionPlan): void {
  if (!plan.tickets.length) {
    console.log("No tickets resolved from input.");
    return;
  }
  console.log(`Run ${plan.runId}\n`);
  for (const t of primaryTickets(plan)) {
    const repos = t.coordinationUnits;
    console.log(
      `${t.id}  [${t.agent}]  ${t.title}\n` +
        (repos
          ? `  one session across ${repos.length} catalog repo(s): ${repos.map((unit) => `${unit.alias}=${unit.repoId} branch=${unit.branch} base=${unit.baseRef}`).join("; ")}\n`
          : `  repo=${t.repoId}  branch=${t.branch}  base=${t.baseRef}\n`) +
        (t.branchNaming ? `  prefix=${t.branchNaming.prefix || "(none)"}  (${t.branchNaming.reason})\n` : "") +
        (t.dependsOn?.length ? `  depends_on=${t.dependsOn.join(",")}\n` : "") +
        (t.conflictsWith.length ? `  ⚠ possible conflict with: ${t.conflictsWith.join(", ")}\n` : ""),
    );
  }
}

function parseRepositorySpec(spec: string): RepoCatalogEntry {
  const [alias, repoId, repoPath, base, ...extra] = spec.split("|");
  if (!alias || !repoId || !repoPath || !base || extra.length) {
    throw new Error(`Invalid --repository "${spec}". Expected alias|owner/repo|/absolute/path|base.`);
  }
  return { alias, repoId, repoPath, base };
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

async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function appendOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
