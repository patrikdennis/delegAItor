import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  buildPlan,
  closeTicket,
  closeDb,
  completeSession,
  dispatchTicket,
  findSession,
  getDb,
  getProfile,
  latestSessions,
  listSessionRepoUnits,
  markWorkUnitFailed,
  persistPlan,
  profileToResolveOptions,
  primaryTickets,
  refreshParentTicketStatus,
  resolveExecutionPlan,
  shipTicket,
  syncBoardStatus,
  ticketOverview,
  workspaceTitle,
} from "../packages/core/dist/index.js";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cliPath = join(repoRoot, "packages/cli/dist/index.js");
const mcpPath = join(repoRoot, "packages/mcp-server/dist/index.js");

async function withHome(run) {
  closeDb();
  const previousHome = process.env.DELEGAITOR_HOME;
  const previousNotion = process.env.NOTION_API_KEY;
  const previousPath = process.env.PATH;
  const previousCmuxLog = process.env.CMUX_TEST_LOG;
  const previousGhState = process.env.GH_TEST_STATE;
  const home = mkdtempSync(join(tmpdir(), "delegaitor-multi-repo-"));
  process.env.DELEGAITOR_HOME = home;
  delete process.env.NOTION_API_KEY;
  try {
    await run(home);
  } finally {
    closeDb();
    if (previousHome === undefined) delete process.env.DELEGAITOR_HOME;
    else process.env.DELEGAITOR_HOME = previousHome;
    if (previousNotion === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = previousNotion;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCmuxLog === undefined) delete process.env.CMUX_TEST_LOG;
    else process.env.CMUX_TEST_LOG = previousCmuxLog;
    if (previousGhState === undefined) delete process.env.GH_TEST_STATE;
    else process.env.GH_TEST_STATE = previousGhState;
    rmSync(home, { recursive: true, force: true });
  }
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  spawnSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  spawnSync("git", ["-C", path, "config", "user.name", "Test User"], { stdio: "ignore" });
  spawnSync("git", ["-C", path, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "temporary test repo\n");
  spawnSync("git", ["-C", path, "add", "README.md"], { stdio: "ignore" });
  const commit = spawnSync("git", ["-C", path, "commit", "-m", "init"], { encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
}

function addOrigin(repoPath, remotePath) {
  spawnSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
  spawnSync("git", ["-C", repoPath, "remote", "add", "origin", remotePath], { stdio: "ignore" });
  const push = spawnSync("git", ["-C", repoPath, "push", "-u", "origin", "main"], { encoding: "utf8" });
  assert.equal(push.status, 0, push.stderr);
}

function installFakeGh(binPath, statePath) {
  const fakeGh = join(binPath, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.GH_TEST_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const value = (flag) => args[args.indexOf(flag) + 1];
const repo = value("--repo");
const head = value("--head") || "HEAD";
const key = repo + ":" + head;
if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify(state[key] ? [state[key]] : []));
} else if (args[0] === "pr" && args[1] === "create") {
  if (state.failCreateRepos && state.failCreateRepos.includes(repo)) {
    process.stderr.write("injected pull request creation failure\\n");
    process.exit(1);
  }
  const pr = { number: 100 + Object.keys(state).length + 1, state: "OPEN", url: "https://github.test/" + repo + "/pull/1", title: value("--title") };
  state[key] = pr;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(pr.url);
} else {
  process.exit(1);
}
`);
  chmodSync(fakeGh, 0o755);
  writeFileSync(statePath, "{}");
}

function startMockNotion() {
  const calls = [];
  let failDone = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/databases/board") {
      res.end(JSON.stringify({
        properties: {
          Status: {
            type: "status",
            status: { options: ["In Progress", "Review / Code Review", "Done"].map((name) => ({ name })) },
          },
        },
      }));
      return;
    }
    if (req.method === "PATCH" && req.url?.startsWith("/v1/pages/")) {
      const status = body?.properties?.Status?.status?.name;
      if (failDone && status === "Done") {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: "mock Notion failure" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        calls,
        setFailDone(value) {
          failDone = value;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function makeBoardPlan(baseUrl, ticketId) {
  const normalized = ["web", "api"].map((repoAlias) => ({
    source: "notion",
    externalId: ticketId,
    externalUrl: `https://notion.test/${ticketId}`,
    title: "Update profile details",
    body: "Ticket description",
    repoId: `owner/${repoAlias}`,
    repoPath: `/tmp/${repoAlias}`,
    repoAlias,
    unitId: `${ticketId}--${repoAlias}`,
  }));
  const plan = buildPlan(normalized, { defaultAgent: "copilot", branchPrefix: "feature/" });
  for (const unit of plan.tickets) {
    unit.boardSync = {
      target: { source: "notion", databaseId: "board", statusProperty: "Status", apiBaseUrl: baseUrl },
      statuses: { in_progress: "In Progress", ready_for_review: "Review / Code Review", done: "Done" },
    };
  }
  return plan;
}

function insertSessions(plan, prefix) {
  const db = getDb();
  const ticket = primaryTickets(plan)[0];
  const sessionId = `${prefix}-session`;
  db.prepare(
    `INSERT INTO sessions (id, ticket_id, work_unit_id, multi_repo, agent, branch, worktree_path, status)
     VALUES (?, ?, NULL, 1, ?, ?, ?, 'running')`,
  ).run(sessionId, ticket.id, ticket.agent, ticket.branch, ticket.workspacePath);
  db.prepare(`UPDATE ticket_units SET status = 'dispatched' WHERE ticket_id = ?`).run(ticket.id);
  return [sessionId];
}

test("multi-repo plans keep one parent and create one planned unit per catalog repository without approval state", async () => {
  await withHome(async (home) => {
    const web = join(home, "web");
    const api = join(home, "api");
    initRepo(web);
    initRepo(api);
    const rules = join(home, "branch-prefixes.json");
    writeFileSync(rules, JSON.stringify({
      default: "feature/",
      prefixes: [{ prefix: "feature/" }, { prefix: "fix/" }],
    }));
    const options = {
      defaultAgent: "copilot",
      branchRulesFile: rules,
      repoCatalog: [
        { alias: "web", repoId: "owner/web", repoPath: web, base: "main" },
        { alias: "api", repoId: "owner/api", repoPath: api, base: "main" },
      ],
    };
    const plan = await resolveExecutionPlan("- Update profile details", options);
    assert.equal(plan.tickets.length, 2);
    assert.deepEqual(plan.multiRepoTicketIds, [plan.tickets[0].id]);
    assert.equal(new Set(plan.tickets.map((unit) => unit.id)).size, 1);
    assert.equal(new Set(plan.tickets.map((unit) => unit.unitId)).size, 2);
    assert.deepEqual(new Set(plan.tickets.map((unit) => unit.repoAlias)), new Set(["web", "api"]));
    assert.ok(plan.tickets.every((unit) => unit.branch.endsWith(`-${unit.repoAlias}`)));
    assert.equal(new Set(plan.tickets.map((unit) => unit.worktreePath)).size, 2);
    assert.ok(plan.tickets.every((unit) => unit.coordinationUnits.length === 2));
    assert.equal(new Set(plan.tickets.map((unit) => unit.workspacePath)).size, 1);
    const unapprovedEquivalent = await resolveExecutionPlan("- Update profile details", {
      ...options,
      repoCatalog: options.repoCatalog.map((repo) => repo.alias === "web" ? { ...repo, repoPath: `${web}-changed` } : repo),
    });
    assert.equal(unapprovedEquivalent.tickets.length, 2);

    persistPlan(plan, "- Update profile details");
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM tickets`).get().count, 1);
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM ticket_units WHERE active = 1`).get().count, 2);
    assert.equal(getDb().prepare(`SELECT COUNT(DISTINCT ticket_id) as count FROM ticket_units WHERE active = 1`).get().count, 1);
    assert.equal(
      getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_routes'`).get(),
      undefined,
    );
  });
});

test("single-repository planning and persistence retain the original ticket identity and branch shape", async () => {
  await withHome(async (home) => {
    const repoPath = join(home, "single");
    initRepo(repoPath);
    const rules = join(home, "branch-prefixes.json");
    writeFileSync(rules, JSON.stringify({ default: "feature/", prefixes: [{ prefix: "feature/" }] }));
    const plan = await resolveExecutionPlan("- Fix validation", {
      defaultAgent: "copilot",
      repo: "owner/single",
      repoPath,
      branchRulesFile: rules,
    });
    assert.equal(plan.multiRepoTicketIds, undefined);
    assert.equal(plan.tickets.length, 1);
    assert.equal(plan.tickets[0].unitId, plan.tickets[0].id);
    assert.equal(plan.tickets[0].branch, "feature/local-1-fix-validation");
    persistPlan(plan, "- Fix validation");
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM tickets`).get().count, 1);
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM ticket_units WHERE active = 1`).get().count, 1);
    assert.equal(getDb().prepare(`SELECT repo_id as repoId FROM ticket_units`).get().repoId, "owner/single");
  });
});

test("legacy single-repo database rows migrate into the default work unit", async () => {
  await withHome(async (home) => {
    const legacy = new Database(join(home, "state.sqlite"));
    legacy.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), prompt TEXT, status TEXT NOT NULL DEFAULT 'planned');
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
        external_url TEXT, title TEXT NOT NULL, body TEXT, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL,
        base_ref TEXT NOT NULL DEFAULT 'main', depends_on TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, agent TEXT NOT NULL, branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL, pid INTEGER, cmux_workspace_id TEXT, status TEXT NOT NULL DEFAULT 'starting',
        result_json TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
      );
      INSERT INTO runs (id, prompt) VALUES ('legacy-run', 'legacy');
      INSERT INTO tickets (id, run_id, source, external_id, title, repo_id, repo_path, status)
        VALUES ('legacy-ticket', 'legacy-run', 'markdown', 'legacy-ticket', 'Legacy ticket', 'owner/legacy', '/repo/legacy', 'dispatched');
      INSERT INTO sessions (id, ticket_id, agent, branch, worktree_path, status)
        VALUES ('legacy-session', 'legacy-ticket', 'copilot', 'feature/legacy-ticket', '/worktrees/legacy-ticket', 'running');
    `);
    legacy.close();

    const db = getDb();
    const unit = db.prepare(`SELECT id, repo_alias as repoAlias, repo_id as repoId, branch, active FROM ticket_units`).get();
    assert.deepEqual(unit, {
      id: "legacy-ticket",
      repoAlias: "default",
      repoId: "owner/legacy",
      branch: "feature/legacy-ticket",
      active: 1,
    });
    assert.equal(db.prepare(`SELECT work_unit_id as unitId FROM sessions WHERE id = 'legacy-session'`).get().unitId, "legacy-ticket");
  });
});

test("migration preserves existing per-repository work units and sessions without adding a phantom default unit", async () => {
  await withHome(async (home) => {
    const legacy = new Database(join(home, "state.sqlite"));
    legacy.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), prompt TEXT, status TEXT NOT NULL DEFAULT 'planned');
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
        external_url TEXT, title TEXT NOT NULL, body TEXT, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL,
        base_ref TEXT NOT NULL DEFAULT 'main', depends_on TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        board_sync_json TEXT, branch_naming_json TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, work_unit_id TEXT, agent TEXT NOT NULL,
        branch TEXT NOT NULL, worktree_path TEXT NOT NULL, pid INTEGER, cmux_workspace_id TEXT,
        status TEXT NOT NULL DEFAULT 'starting', result_json TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
      );
      CREATE TABLE ticket_units (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, repo_alias TEXT NOT NULL, repo_id TEXT NOT NULL,
        repo_path TEXT NOT NULL, base_ref TEXT NOT NULL DEFAULT 'main', branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', branch_naming_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(ticket_id, repo_alias)
      );
      INSERT INTO runs (id, prompt) VALUES ('older-run', 'older multi-unit model');
      INSERT INTO tickets (id, run_id, source, external_id, title, repo_id, repo_path, status)
        VALUES ('older-ticket', 'older-run', 'notion', 'page', 'Existing multi-unit ticket', 'owner/one', '/repo/one', 'dispatched');
      INSERT INTO ticket_units (id, ticket_id, repo_alias, repo_id, repo_path, branch, worktree_path, status)
        VALUES
          ('older-ticket--one', 'older-ticket', 'one', 'owner/one', '/repo/one', 'feature/page-one', '/worktrees/one', 'dispatched'),
          ('older-ticket--two', 'older-ticket', 'two', 'owner/two', '/repo/two', 'feature/page-two', '/worktrees/two', 'dispatched');
      INSERT INTO sessions (id, ticket_id, work_unit_id, agent, branch, worktree_path, status)
        VALUES
          ('older-session-one', 'older-ticket', 'older-ticket--one', 'copilot', 'feature/page-one', '/worktrees/one', 'running'),
          ('older-session-two', 'older-ticket', 'older-ticket--two', 'copilot', 'feature/page-two', '/worktrees/two', 'running');
    `);
    legacy.close();

    const db = getDb();
    const units = db.prepare(
      `SELECT id, repo_alias as repoAlias, active FROM ticket_units WHERE ticket_id = ? ORDER BY repo_alias`,
    ).all("older-ticket");
    assert.deepEqual(units, [
      { id: "older-ticket--one", repoAlias: "one", active: 1 },
      { id: "older-ticket--two", repoAlias: "two", active: 1 },
    ]);
    const sessions = db.prepare(
      `SELECT id, work_unit_id as workUnitId, multi_repo as multiRepo FROM sessions WHERE ticket_id = ? ORDER BY id`,
    ).all("older-ticket");
    assert.deepEqual(sessions, [
      { id: "older-session-one", workUnitId: "older-ticket--one", multiRepo: 0 },
      { id: "older-session-two", workUnitId: "older-ticket--two", multiRepo: 0 },
    ]);
  });
});

test("one parent session stays in progress until repo shipment succeeds and blocks done until safe close", async () => {
  await withHome(async () => {
    const notion = await startMockNotion();
    process.env.NOTION_API_KEY = "test-token";
    try {
      const pendingPlan = makeBoardPlan(notion.baseUrl, "page-pending");
      persistPlan(pendingPlan, "test");
      const pendingUnit = primaryTickets(pendingPlan)[0];
      getDb().prepare(
        `INSERT INTO sessions (id, ticket_id, multi_repo, agent, branch, worktree_path, status)
         VALUES (?, ?, 1, ?, ?, ?, 'running')`,
      ).run("pending-only-session", pendingUnit.id, pendingUnit.agent, pendingUnit.branch, pendingUnit.workspacePath);
      getDb().prepare(`UPDATE ticket_units SET status = 'dispatched' WHERE ticket_id = ?`).run(pendingUnit.id);
      const pendingReview = await completeSession("pending-only-session", "ready_for_review");
      assert.equal(pendingReview.parentStatus, "in_progress");
      assert.equal(pendingReview.boardStatus, undefined);
      assert.equal(notion.calls.filter((call) => call.method === "PATCH").length, 0);

      const plan = makeBoardPlan(notion.baseUrl, "page-success");
      persistPlan(plan, "test");
      const sessions = insertSessions(plan, "success");
      const first = await completeSession(sessions[0], "ready_for_review");
      assert.equal(first.parentStatus, "in_progress");
      assert.equal(first.boardStatus, undefined);
      assert.equal(notion.calls.filter((call) => call.method === "PATCH").length, 0);
      getDb().prepare(`UPDATE ticket_units SET status = 'ready_for_review' WHERE ticket_id = 'page-success'`).run();
      assert.equal(refreshParentTicketStatus("page-success"), "ready_for_review");
      const reviewBoard = await syncBoardStatus("page-success", "ready_for_review");
      assert.equal(reviewBoard?.ok, true);
      assert.deepEqual(
        notion.calls.filter((call) => call.method === "PATCH").map((call) => call.body.properties.Status.status.name),
        ["Review / Code Review"],
      );

      await assert.rejects(completeSession(sessions[0], "done"), /only by closing/);
      getDb().prepare(`UPDATE ticket_units SET status = 'done' WHERE ticket_id = 'page-success'`).run();
      assert.equal(refreshParentTicketStatus("page-success"), "done");
      assert.equal((await syncBoardStatus("page-success", "done"))?.ok, true);

      const failedPlan = makeBoardPlan(notion.baseUrl, "page-failure");
      persistPlan(failedPlan, "test");
      const failedSessions = insertSessions(failedPlan, "failure");
      await completeSession(failedSessions[0], "ready_for_review");
      getDb().prepare(`UPDATE ticket_units SET status = 'ready_for_review' WHERE ticket_id = 'page-failure'`).run();
      refreshParentTicketStatus("page-failure");
      notion.setFailDone(true);
      getDb().prepare(`UPDATE ticket_units SET status = 'done' WHERE ticket_id = 'page-failure'`).run();
      const failedBoardMove = await syncBoardStatus("page-failure", "done");
      assert.equal(refreshParentTicketStatus("page-failure"), "done");
      assert.equal(failedBoardMove?.ok, false);
      assert.match(failedBoardMove?.error ?? "", /mock Notion failure/);
      assert.equal(
        getDb().prepare(`SELECT status FROM tickets WHERE id = 'page-failure'`).get().status,
        "done",
      );
      assert.equal(latestSessions().filter((session) => session.ticketId === "page-success").length, 1);
    } finally {
      delete process.env.NOTION_API_KEY;
      await notion.close();
    }
  });
});

test("multi-repo dispatch rolls back created worktrees and records one truthful failed parent session", async () => {
  await withHome(async (home) => {
    const firstRepo = join(home, "repo-first");
    initRepo(firstRepo);
    const plan = await resolveExecutionPlan("- Update shared settings", {
      defaultAgent: "copilot",
      repoCatalog: [
        { alias: "first", repoId: "owner/first", repoPath: firstRepo, base: "main" },
        { alias: "missing", repoId: "owner/missing", repoPath: join(home, "missing-repo"), base: "main" },
      ],
    });
    persistPlan(plan, "test");
    const ticket = primaryTickets(plan)[0];
    await assert.rejects(dispatchTicket(plan, ticket));
    markWorkUnitFailed(ticket.id);
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM sessions WHERE ticket_id = ?`).get(ticket.id).count, 0);
    assert.equal(
      getDb().prepare(`SELECT COUNT(*) as count FROM ticket_units WHERE ticket_id = ? AND status = 'failed'`).get(ticket.id).count,
      2,
    );
    assert.equal(existsSync(ticket.coordinationUnits.find((unit) => unit.alias === "first").worktreePath), false);
    assert.equal(getDb().prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticket.id).status, "failed");
  });
});

test("one parent ticket dispatch creates every catalog worktree in one workspace and launches one cmux session", async () => {
  await withHome(async (home) => {
    const longTitle = workspaceTitle("A".repeat(100), "fallback");
    assert.ok(longTitle.length <= 60);
    assert.ok(longTitle.endsWith("…"));
    const firstRepo = join(home, "repo-web");
    const secondRepo = join(home, "repo-api");
    initRepo(firstRepo);
    initRepo(secondRepo);
    const fakeBin = join(home, "bin");
    mkdirSync(fakeBin);
    const logPath = join(home, "cmux.log");
    const fakeCmux = join(fakeBin, "cmux");
    writeFileSync(fakeCmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CMUX_TEST_LOG, args.join(" ") + "\\n");
if (args[0] === "ping") console.log("PONG");
else if (args[0] === "new-workspace") console.log("OK workspace:mock-" + Math.random().toString(16).slice(2));
`);
    chmodSync(fakeCmux, 0o755);
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node
console.log("[]");
`);
    chmodSync(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    process.env.CMUX_TEST_LOG = logPath;
    const rules = join(home, "branch-prefixes.json");
    writeFileSync(rules, JSON.stringify({ default: "feature/", prefixes: [{ prefix: "feature/" }] }));
    const options = {
      defaultAgent: "copilot",
      branchRulesFile: rules,
      repoCatalog: [
        { alias: "web", repoId: "owner/web", repoPath: firstRepo, base: "main" },
        { alias: "api", repoId: "owner/api", repoPath: secondRepo, base: "main" },
      ],
    };
    const plan = await resolveExecutionPlan("- Update profile rendering", options);
    persistPlan(plan, "- Update profile rendering");
    const ticket = primaryTickets(plan)[0];
    const result = await dispatchTicket(plan, ticket);
    assert.equal(result.launch.method, "cmux");
    assert.equal(result.worktrees.length, 2);
    assert.equal(result.worktreePath, ticket.workspacePath);
    assert.ok(result.launch.cmuxWorkspaceId);
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM sessions WHERE ticket_id = ?`).get(ticket.id).count, 1);
    assert.equal(getDb().prepare(`SELECT multi_repo as multiRepo FROM sessions WHERE id = ?`).get(result.sessionId).multiRepo, 1);
    assert.equal(listSessionRepoUnits(result.sessionId).length, 2);
    for (const unit of ticket.coordinationUnits) {
      assert.equal(readlinkSync(join(ticket.workspacePath, unit.alias)), unit.worktreePath);
      assert.equal(existsSync(unit.repoPath), true);
      assert.equal(existsSync(unit.worktreePath), true);
    }
    const prompt = readFileSync(join(home, "runs", plan.runId, "prompts", `${ticket.id}.md`), "utf8");
    assert.match(prompt, /one session and 2 isolated repository worktree/);
    assert.match(prompt, /original clones are read-only context/);
    assert.match(prompt, /base main/);
    assert.match(prompt, /decide which repos are affected/);
    for (const unit of ticket.coordinationUnits) {
      assert.ok(prompt.includes(`${unit.alias} (${unit.repoId})`));
      assert.ok(prompt.includes(`folder ${ticket.workspacePath}/${unit.alias}, worktree ${unit.worktreePath}, branch ${unit.branch}, base ${unit.baseRef}`));
    }
    const log = readFileSync(logPath, "utf8");
    assert.equal(log.split("\n").filter((line) => line.startsWith("new-workspace")).length, 1);
    assert.equal(log.split("\n").filter((line) => line.startsWith("rename-workspace")).length, 1);
    assert.ok(log.includes(ticket.workspacePath));
    assert.ok(!log.includes("[web]"));
    const overview = await ticketOverview({ pullRequests: true });
    assert.equal(overview.length, 1);
    assert.equal(overview[0].units.length, 2);
    assert.equal(overview[0].next, "working");
    assert.equal(overview[0].units.filter((unit) => unit.repoId).length, 2);
    delete process.env.CMUX_TEST_LOG;
  });
});

test("multi-repo ship skips untouched repos, rejects dirty repos, and close waits for merged PRs with safe retry", async () => {
  await withHome(async (home) => {
    const web = join(home, "web");
    const api = join(home, "api");
    initRepo(web);
    initRepo(api);
    const webOrigin = join(home, "web-origin.git");
    addOrigin(web, webOrigin);
    addOrigin(api, join(home, "api-origin.git"));

    const fakeBin = join(home, "bin");
    mkdirSync(fakeBin);
    const ghState = join(home, "gh-state.json");
    installFakeGh(fakeBin, ghState);
    const fakeCmux = join(fakeBin, "cmux");
    writeFileSync(fakeCmux, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ping") console.log("PONG");
else if (args[0] === "new-workspace") console.log("OK workspace:lifecycle");
`);
    chmodSync(fakeCmux, 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    process.env.GH_TEST_STATE = ghState;

    const plan = await resolveExecutionPlan("- Update shared details", {
      defaultAgent: "copilot",
      repoCatalog: [
        { alias: "web", repoId: "owner/web", repoPath: web, base: "main" },
        { alias: "api", repoId: "owner/api", repoPath: api, base: "main" },
      ],
    });
    persistPlan(plan, "test");
    const ticket = primaryTickets(plan)[0];
    const dispatched = await dispatchTicket(plan, ticket);
    const repos = listSessionRepoUnits(dispatched.sessionId);
    const webUnit = repos.find((unit) => unit.repoAlias === "web");
    const apiUnit = repos.find((unit) => unit.repoAlias === "api");
    assert.ok(webUnit && apiUnit);

    const dirtyFile = join(apiUnit.worktreePath, "temporary-uncommitted.txt");
    writeFileSync(dirtyFile, "dirty\n");
    await assert.rejects(shipTicket(dispatched.sessionId), /uncommitted changes/);
    assert.deepEqual(JSON.parse(readFileSync(ghState, "utf8")), {});
    rmSync(dirtyFile);

    writeFileSync(join(webUnit.worktreePath, "README.md"), "web change\n");
    spawnSync("git", ["-C", webUnit.worktreePath, "add", "README.md"], { stdio: "ignore" });
    const commit = spawnSync("git", ["-C", webUnit.worktreePath, "commit", "-m", "change web details"], { encoding: "utf8" });
    assert.equal(commit.status, 0, commit.stderr);
    await completeSession(dispatched.sessionId, "ready_for_review", "Worked through both catalog repos.");

    const shipped = await shipTicket(dispatched.sessionId, { title: "Update details", body: "Changes and tests." });
    assert.deepEqual(
      shipped.units.map((unit) => [unit.repoAlias, unit.status]),
      [["api", "no_changes"], ["web", "shipped"]],
    );
    assert.equal(shipped.parentStatus, "ready_for_review");
    assert.equal(shipped.units.filter((unit) => unit.pullRequest).length, 1);
    const openState = JSON.parse(readFileSync(ghState, "utf8"));
    const webKey = Object.keys(openState).find((key) => key.startsWith("owner/web:"));
    assert.ok(webKey);
    await assert.rejects(closeTicket(dispatched.sessionId, { dryRun: true }), /still open/);

    openState[webKey].state = "MERGED";
    writeFileSync(ghState, JSON.stringify(openState));
    const preview = await closeTicket(dispatched.sessionId, { dryRun: true });
    assert.equal(preview.units.find((unit) => unit.repoAlias === "web").status, "closed");
    assert.equal(existsSync(webUnit.worktreePath), true);
    assert.equal(existsSync(apiUnit.worktreePath), true);

    const updateHook = join(webOrigin, "hooks", "update");
    writeFileSync(updateHook, `#!/bin/sh
if [ "$3" = "0000000000000000000000000000000000000000" ]; then
  echo "injected remote delete failure" >&2
  exit 1
fi
exit 0
`);
    chmodSync(updateHook, 0o755);
    const partialClose = await closeTicket(dispatched.sessionId);
    assert.equal(partialClose.units.find((unit) => unit.repoAlias === "web").status, "failed");
    assert.equal(getDb().prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticket.id).status, "ready_for_review");
    assert.equal(getDb().prepare(`SELECT status FROM ticket_units WHERE id = ?`).get(webUnit.unitId).status, "cleanup_failed");

    writeFileSync(updateHook, "#!/bin/sh\nexit 0\n");
    chmodSync(updateHook, 0o755);
    const retry = await closeTicket(dispatched.sessionId);
    assert.ok(retry.units.every((unit) => unit.status !== "failed"));
    assert.equal(retry.parentStatus, "done");
    assert.equal(getDb().prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticket.id).status, "done");
    assert.equal(existsSync(ticket.workspacePath), false);
    assert.equal(existsSync(webUnit.worktreePath), false);
    assert.equal(existsSync(apiUnit.worktreePath), false);
    assert.equal(readFileSync(join(web, "README.md"), "utf8"), "temporary test repo\n");
    assert.equal(readFileSync(join(api, "README.md"), "utf8"), "temporary test repo\n");
    delete process.env.GH_TEST_STATE;
  });
});

test("one repo PR failure keeps the multi-repo parent in progress and can be retried", async () => {
  await withHome(async (home) => {
    const api = join(home, "api");
    const web = join(home, "web");
    initRepo(api);
    initRepo(web);
    addOrigin(api, join(home, "api-origin.git"));
    addOrigin(web, join(home, "web-origin.git"));
    const fakeBin = join(home, "bin");
    mkdirSync(fakeBin);
    const ghState = join(home, "gh-state.json");
    installFakeGh(fakeBin, ghState);
    const fakeCmux = join(fakeBin, "cmux");
    writeFileSync(fakeCmux, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ping") console.log("PONG");
else if (args[0] === "new-workspace") console.log("OK workspace:ship-retry");
`);
    chmodSync(fakeCmux, 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    process.env.GH_TEST_STATE = ghState;
    const plan = await resolveExecutionPlan("- Update both parts", {
      defaultAgent: "copilot",
      repoCatalog: [
        { alias: "api", repoId: "owner/api", repoPath: api, base: "main" },
        { alias: "web", repoId: "owner/web", repoPath: web, base: "main" },
      ],
    });
    persistPlan(plan, "test");
    const ticket = primaryTickets(plan)[0];
    const dispatch = await dispatchTicket(plan, ticket);
    for (const unit of listSessionRepoUnits(dispatch.sessionId)) {
      writeFileSync(join(unit.worktreePath, "README.md"), `${unit.repoAlias} change\n`);
      spawnSync("git", ["-C", unit.worktreePath, "add", "README.md"], { stdio: "ignore" });
      const commit = spawnSync("git", ["-C", unit.worktreePath, "commit", "-m", `change ${unit.repoAlias}`], { encoding: "utf8" });
      assert.equal(commit.status, 0, commit.stderr);
    }
    await completeSession(dispatch.sessionId, "ready_for_review", "Both repos changed.");
    writeFileSync(ghState, JSON.stringify({ failCreateRepos: ["owner/api"] }));
    const partial = await shipTicket(dispatch.sessionId);
    assert.deepEqual(partial.units.map((unit) => [unit.repoAlias, unit.status]), [["api", "failed"], ["web", "shipped"]]);
    assert.equal(partial.parentStatus, "in_progress");
    assert.equal(partial.boardStatus, undefined);
    assert.equal(getDb().prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticket.id).status, "in_progress");

    const state = JSON.parse(readFileSync(ghState, "utf8"));
    delete state.failCreateRepos;
    writeFileSync(ghState, JSON.stringify(state));
    const retried = await shipTicket(dispatch.sessionId);
    assert.ok(retried.units.every((unit) => unit.status === "shipped"));
    assert.equal(retried.parentStatus, "ready_for_review");
    assert.equal(getDb().prepare(`SELECT status FROM tickets WHERE id = ?`).get(ticket.id).status, "ready_for_review");
    delete process.env.GH_TEST_STATE;
  });
});

function createJsonRpcClient(commandPath, env) {
  const child = spawn(process.execPath, [commandPath], { stdio: ["pipe", "pipe", "pipe"], env });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}\n${stderr}`));
        else resolve(message.result);
      }
    }
  });
  return {
    child,
    async request(method, params) {
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return result;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

test("CLI keeps legacy single-repo planning and dispatches catalog tickets without route approval", async () => {
  await withHome(async (home) => {
    const singleRepoPath = join(home, "single-repo");
    initRepo(singleRepoPath);
    const singleTicketFile = join(home, "single-ticket.md");
    writeFileSync(singleTicketFile, "- Fix validation\n");
    const singleRepoPlan = spawnSync(process.execPath, [
      cliPath, "plan", "--file", singleTicketFile, "--repo", "owner/single", "--repo-path", singleRepoPath,
    ], { encoding: "utf8", env: process.env });
    assert.equal(singleRepoPlan.status, 0, singleRepoPlan.stderr);
    assert.match(singleRepoPlan.stdout, /repo=owner\/single/);

    const web = join(home, "web");
    const api = join(home, "api");
    initRepo(web);
    initRepo(api);
    const profile = spawnSync(process.execPath, [
      cliPath, "profile", "save", "multi", "--agent", "copilot",
      "--repository", `web|owner/web|${web}|main`,
      "--repository", `api|owner/api|${api}|main`,
    ], { encoding: "utf8", env: process.env });
    assert.equal(profile.status, 0, profile.stderr);
    const conflictingProfile = spawnSync(process.execPath, [
      cliPath, "profile", "save", "conflicting", "--repo", "owner/web", "--repo-path", web,
      "--repository", `web|owner/web|${web}|main`,
    ], { encoding: "utf8", env: process.env });
    assert.notEqual(conflictingProfile.status, 0);
    assert.match(conflictingProfile.stderr, /cannot be combined with single-repository repo\/repoPath/i);
    const ticketFile = join(home, "tickets.md");
    writeFileSync(ticketFile, "- Check the page title\n");
    const plan = spawnSync(process.execPath, [
      cliPath, "plan", "--file", ticketFile, "--profile", "multi",
    ], { encoding: "utf8", env: process.env });
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /one session across 2 catalog repo/);
    assert.doesNotMatch(plan.stdout, /approval|required|routingRequired/i);
    for (const conflictingArgs of [
      ["--repo", "owner/web"],
      ["--repo-path", web],
    ]) {
      const conflict = spawnSync(process.execPath, [
        cliPath, "plan", "--file", ticketFile, "--profile", "multi", ...conflictingArgs,
      ], { encoding: "utf8", env: process.env });
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /cannot be combined with single-repository repo\/repoPath/i);
    }

    const fakeBin = join(home, "bin");
    mkdirSync(fakeBin);
    const fakeCmux = join(fakeBin, "cmux");
    writeFileSync(fakeCmux, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ping") console.log("PONG");
else if (args[0] === "new-workspace") console.log("OK workspace:cli-test");
`);
    chmodSync(fakeCmux, 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    const dispatch = spawnSync(process.execPath, [
      cliPath, "dispatch", "--file", ticketFile, "--profile", "multi", "--yes",
    ], { encoding: "utf8", env: process.env });
    assert.equal(dispatch.status, 0, `${dispatch.stdout}\n${dispatch.stderr}`);
    assert.match(dispatch.stdout, /session=/);
    assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM sessions`).get().count, 1);
    assert.equal(getDb().prepare(`SELECT multi_repo FROM sessions`).get().multi_repo, 1);
  });
});

test("MCP plan and dispatch use one catalog session and retain the Notion assignee override", async () => {
  await withHome(async (home) => {
    const web = join(home, "web");
    const api = join(home, "api");
    initRepo(web);
    initRepo(api);
    const fakeBin = join(home, "bin");
    mkdirSync(fakeBin);
    const fakeCmux = join(fakeBin, "cmux");
    writeFileSync(fakeCmux, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ping") console.log("PONG");
else if (args[0] === "new-workspace") console.log("OK workspace:mcp-test");
`);
    chmodSync(fakeCmux, 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    const client = createJsonRpcClient(mcpPath, process.env);
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "regression-test", version: "1.0.0" },
      });
      client.notify("notifications/initialized", {});
      const tools = await client.request("tools/list", {});
      const names = new Set(tools.tools.map((tool) => tool.name));
      assert.ok(!names.has("delegaitor_repo_propose"));
      assert.ok(!names.has("delegaitor_repo_approve"));
      assert.ok(!names.has("delegaitor_repo_routes"));
      assert.ok(tools.tools.find((tool) => tool.name === "delegaitor_plan").inputSchema.properties.notionAssigneeProp);

      const saved = await client.request("tools/call", {
        name: "delegaitor_profile_save",
        arguments: {
          name: "mcp-profile",
          notionDatabaseId: "board",
          notionAssigneeProp: "People",
          repositories: [
            { alias: "web", repoId: "owner/web", repoPath: web, base: "main" },
            { alias: "api", repoId: "owner/api", repoPath: api, base: "main" },
          ],
        },
      });
      assert.match(saved.content[0].text, /notionAssigneeProp/);
      assert.equal(profileToResolveOptions(getProfile("mcp-profile")).notion.properties.assignee, "People");

      const plan = await client.request("tools/call", {
        name: "delegaitor_plan",
        arguments: { profile: "mcp-profile", notionDatabaseId: "", text: "- MCP plan ticket" },
      });
      const decodedPlan = JSON.parse(plan.content[0].text);
      assert.equal(decodedPlan.tickets.length, 2);
      assert.equal(decodedPlan.multiRepoTicketIds.length, 1);
      assert.equal(new Set(decodedPlan.tickets.map((unit) => unit.id)).size, 1);
      const conflictingPlan = await client.request("tools/call", {
        name: "delegaitor_plan",
        arguments: { profile: "mcp-profile", repoPath: web, notionDatabaseId: "", text: "- MCP conflict ticket" },
      });
      assert.equal(conflictingPlan.isError, true);
      assert.match(conflictingPlan.content[0].text, /cannot be combined with single-repository repo\/repoPath/i);

      const dispatched = await client.request("tools/call", {
        name: "delegaitor_dispatch",
        arguments: { profile: "mcp-profile", notionDatabaseId: "", text: "- MCP dispatch ticket" },
      });
      const dispatchReport = JSON.parse(dispatched.content[0].text);
      assert.equal(dispatchReport.tickets.length, 1);
      assert.equal(dispatchReport.tickets[0].repositories.length, 2);
      assert.equal(getDb().prepare(`SELECT COUNT(*) as count FROM sessions`).get().count, 1);
    } finally {
      client.child.kill("SIGTERM");
      await Promise.race([new Promise((done) => client.child.once("exit", done)), delay(3000)]);
    }
  });
});

test("profile save --merge adds, replaces and removes catalog repositories by alias", async () => {
  await withHome(async (home) => {
    const cli = (...args) => {
      const r = spawnSync(process.execPath, [cliPath, "profile", "save", "board", ...args], {
        encoding: "utf8",
        env: { ...process.env, DELEGAITOR_HOME: home },
      });
      return r;
    };
    const aliases = () => getProfile("board").repositories?.map((r) => `${r.alias}:${r.base}`) ?? [];

    assert.equal(cli("--notion-db", "db", "--repository", "web|example/web|/tmp/web|main", "--repository", "api|example/api|/tmp/api|main").status, 0);
    assert.deepEqual(aliases(), ["web:main", "api:main"]);

    assert.equal(cli("--merge", "--description", "only the description").status, 0);
    assert.deepEqual(aliases(), ["web:main", "api:main"], "an unrelated merge keeps the catalog");

    assert.equal(cli("--merge", "--repository", "jobs|example/jobs|/tmp/jobs|main").status, 0);
    assert.deepEqual(aliases(), ["web:main", "api:main", "jobs:main"], "a new alias is appended");

    assert.equal(cli("--merge", "--repository", "api|example/api|/tmp/api|develop").status, 0);
    assert.deepEqual(aliases(), ["web:main", "api:develop", "jobs:main"], "an existing alias is replaced in place");

    assert.equal(cli("--remove-repository", "web").status, 0);
    assert.deepEqual(aliases(), ["api:develop", "jobs:main"], "remove implies merge and drops only that alias");

    const typo = cli("--remove-repository", "nope");
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /No repository alias "nope"/);
    assert.deepEqual(aliases(), ["api:develop", "jobs:main"], "a failed removal changes nothing");
  });
});
