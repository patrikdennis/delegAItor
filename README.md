# delegAItor

Delegates multiple tickets — from GitHub Issues, plain markdown lists, or a
Notion database — into isolated git worktrees/branches, each with its own
agent session (Claude, Copilot, Codex, or OpenCode), and keeps those
sessions in sync via a shared SQLite-backed lock + messaging registry.

One prompt in → a plan showing branches, worktrees, and flagged conflicts →
confirm → one cmux workspace (or detached process) per ticket, each running
a `ticket-worker` agent that reports status and coordinates with siblings
before completing.

## Architecture

```
packages/
  core/         SQLite state, ticket-source adapters, git worktree ops,
                agent-runtime launchers, resource locks + messaging,
                planner + orchestrator. No CLI/MCP-specific code.
  cli/          `delegaitor` binary — thin wrapper over @delegaitor/core.
  mcp-server/   `delegaitor-mcp` — exposes the same operations as MCP tools
                so Claude/Copilot can call them natively in-session.
```

All state (SQLite DB, worktrees, prompt files) lives under
`$DELEGAITOR_HOME` (default `~/.delegaitor`), outside any managed repo, so
cleanup never touches your primary checkout. SQLite runs in WAL mode, so the
CLI, the MCP server, and every dispatched agent session can safely read/write
the same state concurrently — this is what lets sessions "converse."

## Install

```bash
cd packages/cli && npm link          # delegaitor on PATH
cd ../mcp-server && npm link         # delegaitor-mcp on PATH
```

Register the MCP server so Claude/Copilot can call delegAItor tools
directly instead of shelling out:

```bash
copilot mcp add delegaitor -- delegaitor-mcp
claude mcp add -s user delegaitor -- delegaitor-mcp
```

The `ticket-worker` custom agent (used by dispatched Copilot sessions) is
installed at user scope: `~/.copilot/agents/ticket-worker.md`. Claude
sessions get equivalent instructions inline in the generated prompt, so no
separate subagent profile is required.

## CLI usage

```bash
# Preview only — no worktrees/agents created:
delegaitor plan --repo owner/repo <<'EOF'
- Fix validation of customer IDs
- Add rate limiting to the checkout API
EOF

# Same input, but actually create branches/worktrees and launch agents:
delegaitor dispatch --repo owner/repo --agent claude <<'EOF'
- Fix validation of customer IDs
- Add rate limiting to the checkout API
EOF

# GitHub issue refs work directly, mixed repos included:
delegaitor dispatch <<'EOF'
#1234
other-org/other-repo#42
EOF

# Also pull every open GitHub issue assigned to you in --repo:
delegaitor dispatch --repo owner/repo --github-mine

# Notion, Linear, Jira — shared/scrum boards default to "assigned to me
# only" (see Ticket sources below); pass --all to pull the whole board:
delegaitor dispatch --notion-db <database-id> --repo owner/repo
delegaitor dispatch --linear --linear-team ENG --repo owner/repo
delegaitor dispatch --jira-project ENG --repo owner/repo
delegaitor dispatch --notion-db <database-id> --all --repo owner/repo
```

Multi-line ticket text must go via stdin (heredoc) or `--file`; a leading
`-` in a shell positional argument is parsed as a flag by Commander.
Listing an explicit ticket title/id/URL in the input text always overrides
the mine/all filtering on shared boards, regardless of `--all`.

Status, locks, and messaging (also exposed as MCP tools of the same name
with a `delegaitor_` prefix):

```bash
delegaitor status
delegaitor lock acquire --session <id> --ticket <id> --resource <path>
delegaitor lock release --session <id> --resource <path>
delegaitor message send --session <id> --to-ticket <id> --kind conflict --body "..."
delegaitor message inbox --ticket <id>
delegaitor session complete --session <id> --status ready_for_review --summary "..."
```

## Cleanup

Nothing destructive happens by default. Cleanup is opt-in and gated:

```bash
# Preview what a full cleanup pass would do, with the recommended safe modes:
delegaitor cleanup --dry-run

# Actually clean up every finished session's worktree/branch, but only
# if the worktree has no uncommitted changes and the branch is merged:
delegaitor cleanup --remove-worktree if-clean --delete-branch if-merged

# One specific session, forcing past the safety checks:
delegaitor session cleanup --session <id> --remove-worktree force --delete-branch force --delete-remote
```

- `--remove-worktree never|if-clean|force` (default `never` for
  `session cleanup`, `if-clean` for the batch `cleanup` command).
- `--delete-branch never|if-merged|force` (default `never`/`if-merged`
  respectively).
- `--delete-remote` also deletes the remote branch, subject to the same
  `--delete-branch` gate.
- `--dry-run` reports what would happen without touching anything.
- The batch `delegaitor cleanup` command finds every `completed`/`failed`/
  `cancelled` session, closes its cmux workspace tab, and applies the same
  gated worktree/branch cleanup to each.

## Coordination protocol

Every dispatched ticket's prompt instructs the agent to:

1. Call `lock acquire` before editing a resource another ticket in the same
   batch might also touch (flagged in the plan's `conflictsWith`).
2. If held by another session, send a `conflict` message to that ticket and
   poll `message inbox` instead of racing the edit.
3. Release the lock when done with that resource.
4. Report `session complete` with `ready_for_review` or `blocked` when
   finished, which also releases any locks it still holds.

Locks are advisory — they coordinate cooperating agents, not a hard
filesystem-level guarantee.

## cmux integration

If the `cmux` CLI is on PATH, `delegaitor dispatch` opens one
`cmux new-workspace --cwd <worktree> --command <agent invocation>` per
ticket and renames it to the ticket title. Without cmux, it falls back to a
detached background process. A global cmux action is installed at
`~/.config/cmux/cmux.json` (`delegaitor.dispatch` / `delegaitor.status`,
also in the surface tab bar) — reload cmux config (Cmd+Shift+,) to pick it
up.

## Ticket sources

- **GitHub Issues** — via `gh issue view`, reusing your existing `gh` auth.
  Matches `#123` (uses `--repo`) and `owner/repo#123` anywhere in the input.
  Pass `--github-mine` to also pull every open issue assigned to you in
  `--repo`.
- **Markdown/plain text** — a `-`/`*` list; supports `repo:`/`base:` header
  lines, a per-line `[owner/repo]` override, and `(after <title>)` for
  in-batch dependencies.
- **Notion** — set `NOTION_API_KEY` and pass `--notion-db <id>`; property
  names (title/status/repo/body/assignee) are configurable since Notion
  schemas are user-defined (see `packages/core/src/tickets/notion.ts`).
- **Linear** — set `LINEAR_API_KEY` and pass `--linear` (optionally
  `--linear-team <key>` to scope to one team). Unverified against a live
  Linear account — logic follows the documented GraphQL schema; test with
  `plan` first.
- **Jira** — set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and pass
  `--jira-project <key>` (or `--jira-jql <jql>` for a fully custom query).
  Unverified against a live Jira instance — test with `plan` first.

### "Not all tickets are yours" — assignee scoping on shared boards

Notion, Linear, and Jira boards are usually shared across a whole team, so
by default all three are scoped to **assigned to you only**:

- Notion: server-side `people.contains` filter on the assignee property
  (auto-resolves your user id via `/v1/users/me`).
- Linear: `assignee: { isMe: { eq: true } }` GraphQL filter.
- Jira: `assignee = currentUser()` JQL clause (and Jira additionally
  *requires* a `--jira-project` if you opt out of this, so `--all` can't
  accidentally scan your entire Jira instance).

Pass `--all` to pull every open/ready ticket on the board instead. Either
way, explicitly naming a ticket's title, id, or URL in the input text always
resolves that specific ticket regardless of assignee — explicit mention is
treated as explicit intent.

## Known limitations

- Conflict detection is a static heuristic (shared path-like substrings in
  ticket text), not a real diff/AST analysis — it flags candidates for the
  agent to check via locks, not guaranteed conflicts.
- Locks/messages are advisory; nothing stops an agent from ignoring the
  protocol and editing a locked resource directly.
- `opencode run` interactivity is unverified — check your installed
  version's behavior before relying on it for steerable sessions.
- Linear and Jira adapters are logic-reviewed and mock-tested (request
  shape, filter construction, assignee/`--all`/explicit-selection
  behavior) but have not been exercised against real Linear/Jira accounts.
  Run `delegaitor plan` first to sanity-check output before `dispatch`.
