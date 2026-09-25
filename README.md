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

Verify it worked:

```bash
delegaitor --help
delegaitor-mcp --version   # should print without error, then exit (it's a stdio server)
```

If `npm link` fails with a permissions error, either fix your global npm
prefix (`npm config get prefix`) or run with a user-writable prefix, e.g.
`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`.

### Registering the MCP server (so Claude/Copilot can call delegAItor tools directly)

This step is optional but recommended: without it, an agent can still run
the `delegaitor` CLI via its shell tool, but registering the MCP server
lets it call `delegaitor_plan`, `delegaitor_dispatch`, `delegaitor_lock_*`,
etc. as native tool calls instead of shelling out, which most agents do
more reliably.

```bash
# Copilot CLI:
copilot mcp add delegaitor -- delegaitor-mcp

# Claude Code (user scope, available in every project):
claude mcp add -s user delegaitor -- delegaitor-mcp
```

Verify each registered correctly:

```bash
copilot mcp list     # should show "delegaitor" as connected
claude mcp list       # should show "delegaitor: ... - ✓ Connected"
```

If a session was already open before you registered the server, restart it
— MCP servers are only picked up at session start.

The `ticket-worker` custom agent (used by dispatched Copilot sessions) is
installed at user scope: `~/.copilot/agents/ticket-worker.md`. Claude
sessions get equivalent instructions inline in the generated prompt, so no
separate subagent profile is required. If that file is missing (e.g. you
copied the repo to a new machine), copy it back into place from
`packages/cli`'s generated prompt templates or re-run whatever setup step
originally created it in your environment.

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
detached background process.

**Setup** (only needed once):

1. Make sure the `cmux` CLI is installed and on `PATH` — check with
   `cmux --version`. If it's missing, install/build cmux per its own
   project instructions; delegAItor doesn't bundle or install it.
2. A global cmux action is installed at `~/.config/cmux/cmux.json`
   (`delegaitor.dispatch` / `delegaitor.status`, also surfaced in the tab
   bar). If that file doesn't already exist or was created before you set
   up delegAItor, copy/merge the `delegaitor.*` action entries from this
   repo's own `~/.config/cmux/cmux.json` example, or add them manually —
   see cmux's config docs for the action schema.
3. Reload cmux's config to pick up the change: `Cmd+Shift+,`, or fully
   restart cmux — there is no `cmux reload-config` command in current
   builds.
4. Verify: run `delegaitor dispatch ...` from a terminal and confirm a new
   cmux tab/workspace opens per ticket, titled with the ticket name.

Without cmux at all, everything still works — dispatched sessions just run
as detached background processes instead of separate tabs, and `delegaitor
status` is your way to check on them instead of switching tabs.

## Ticket sources

- **GitHub Issues** — via `gh issue view`, reusing your existing `gh` auth.
  Matches `#123` (uses `--repo`) and `owner/repo#123` anywhere in the input.
  Pass `--github-mine` to also pull every open issue assigned to you in
  `--repo`. See "Setting up GitHub" below.
- **Markdown/plain text** — a `-`/`*` list; supports `repo:`/`base:` header
  lines, a per-line `[owner/repo]` override, and `(after <title>)` for
  in-batch dependencies. No setup required.
- **Notion** — set `NOTION_API_KEY` and pass `--notion-db <id>`; property
  names (title/status/repo/body/assignee) are configurable since Notion
  schemas are user-defined (see `packages/core/src/tickets/notion.ts`).
  See "Setting up Notion" below.
- **Linear** — set `LINEAR_API_KEY` and pass `--linear` (optionally
  `--linear-team <key>` to scope to one team). See "Setting up Linear"
  below. Unverified against a live Linear account — logic follows the
  documented GraphQL schema; test with `plan` first.
- **Jira** — set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and pass
  `--jira-project <key>` (or `--jira-jql <jql>` for a fully custom query).
  See "Setting up Jira" below. Unverified against a live Jira instance —
  test with `plan` first.

### Setting up GitHub

No API key needed — delegAItor shells out to the `gh` CLI and reuses
whatever account it's already authenticated as.

1. Install the GitHub CLI if you don't have it: `brew install gh` (macOS)
   or see [cli.github.com](https://cli.github.com/).
2. Authenticate once: `gh auth login` and follow the prompts (browser or
   token-based auth both work).
3. Confirm it works: `gh issue list --repo owner/repo --limit 1`.
4. Use it:
   ```bash
   # Explicit issue refs, current or another repo:
   delegaitor plan --repo owner/repo <<'EOF'
   #1234
   other-org/other-repo#42
   EOF

   # Every open issue assigned to you in owner/repo:
   delegaitor plan --repo owner/repo --github-mine

   # Also include each issue's comment thread as extra context for the agent:
   delegaitor plan --repo owner/repo --github-mine --github-comments
   ```
5. **Context passed to the agent**: by default only the issue title and
   body/description are included in the prompt. Pass `--github-comments`
   to also fetch and include the full comment thread (an extra `gh` call
   per issue, so it's opt-in) — useful when the real spec/discussion
   happened in comments rather than the original issue body.

If `gh` isn't authenticated, `delegaitor` will surface `gh`'s own auth
error — run `gh auth status` to check.

### Setting up Notion

delegAItor talks to Notion purely over `Authorization: Bearer <token>` — it
doesn't care whether that token is a Personal Access Token, an Internal
integration secret, or an OAuth access token; all three work identically as
`NOTION_API_KEY`. Workspace admins can restrict who's allowed to create
each kind, so **try these in order** and use whichever one your workspace
actually lets you create:

#### Option A — Personal Access Token (try this first)

The simplest option: acts as *you*, doesn't require sharing pages with a
bot, and doesn't require workspace-owner permissions (just workspace
membership, subject to admin policy).

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
   → **Developer portal** → find **Personal access tokens** (or go directly
   to [notion.so/developers/tokens](https://www.notion.so/developers/tokens)).
2. Click **Create token** (or similar), give it a name, choose the
   workspace, and check the **Notion API** capability.
3. Copy the token immediately — Notion won't show it again. This is your
   `NOTION_API_KEY`.
4. Skip straight to "Get the database id" below — a PAT already has access
   to everything you personally can see, so there's no separate
   page-sharing step.

If this option is greyed out or errors with a permissions message, your
workspace admin has restricted PAT creation with API access — try Option B
or C instead (or ask them to allow it, under **Settings → Connections** in
Notion, "Who can create PATs").

#### Option B — Internal integration (if your workspace allows it)

1. At [notion.so/my-integrations](https://www.notion.so/my-integrations),
   click **New integration** and choose the **API token** authentication
   method (not OAuth).
2. Give it a name (e.g. "delegAItor"), select the workspace, and under
   **Capabilities** make sure **Read content** is checked.
3. Click **Submit** and copy the **Internal Integration Secret** — this is
   your `NOTION_API_KEY`.
4. **Share your ticket database with it** (skip this and every query
   silently returns zero results, not an error): open the database →
   `•••` menu (top-right) → **Connections** → search for and select the
   integration you just created.

If the "API token" option is greyed out with *"You don't have permission
to create internal connections in this workspace"*, your workspace admin
has disabled it — use Option A or C instead.

#### Option C — OAuth public connection (fallback if A and B are both blocked)

Some workspaces restrict both PAT creation and internal integrations,
leaving OAuth as the only remaining path. It's more setup, but a helper
script in this repo automates the whole exchange:

1. At [notion.so/my-integrations](https://www.notion.so/my-integrations),
   click **New integration**, choose **OAuth** as the authentication
   method, set **Installable in** to "Any workspace" (or your own if
   listed), and set a **Redirect URI** of `http://localhost:3000/callback`
   (or any local port you like — just keep it consistent below).
2. Click **Create connection**, then open its **Configuration** tab and
   copy the **OAuth Client ID** and **OAuth Client Secret**.
3. Run the helper script (no extra dependencies — plain Node):
   ```bash
   node scripts/notion-oauth-login.mjs \
     --client-id <your-client-id> \
     --client-secret <your-client-secret> \
     --redirect-uri http://localhost:3000/callback
   ```
4. It opens your browser to Notion's authorization page — log in, pick
   your workspace, and **select which pages/databases to grant access to**
   (this replaces the "share with integration" step from Option B).
5. After you approve, the script prints your access token — export it:
   ```bash
   export NOTION_API_KEY=<printed access token>
   ```

This token is scoped to you personally (like a PAT), so the default
"assigned to me" filter works automatically with no extra setup.

#### Once you have a token (any option above)

1. **Get the database id**: open the database as a full page and copy the
   id out of the URL:
   `https://www.notion.so/<workspace>/<DATABASE_ID>?v=<view_id>` — the
   `DATABASE_ID` is a 32-character hex string (dashes optional, delegAItor
   accepts either form).
2. **Check your database's property names** against delegAItor's defaults,
   since Notion schemas are entirely user-defined:
   - Title property: defaults to `Name`.
   - Status property: defaults to `Status` (a Select property).
   - Assignee property: defaults to `Assignee` (a Person property).
   - If your database uses different names for these three, there's
     currently no CLI flag for them — call `notionTicketSource()` directly
     from `packages/core/src/tickets/notion.ts` with a `properties: {...}`
     override (e.g. `{ title: "Task", assignee: "Owner" }`), or add CLI
     flags yourself (`--notion-title-prop`, etc.) as a small PR.
3. **Context passed to the agent**: by default delegAItor fetches each
   page's actual **body content** — the paragraphs/headings/bullet lists
   written below the title and properties, the same text you see
   scrolling down the page — and includes it in the agent's prompt. This
   needs no configuration and works out of the box; if your board also
   has a dedicated rich-text database *property* used for specs/details
   (a column, not page content), point delegAItor at it too with
   `--notion-body-prop <name>`:
   ```bash
   delegaitor plan --notion-db <database-id> --notion-body-prop "Spec" --repo owner/repo
   ```
   Both are appended together when both are present. To skip fetching
   page content entirely (fewer API calls, useful for very large
   databases), pass `--notion-no-page-content`.
4. **Export the token and preview** (no worktrees/agents created yet):
   ```bash
   export NOTION_API_KEY=<your token from option A, B, or C>
   delegaitor plan --notion-db <database-id> --repo owner/repo
   ```
5. **Restrict to specific board columns/stages** with `--notion-status`
   (recommended — otherwise every status, including Done, is pulled): pass
   a comma-separated list matching your Status column's values exactly,
   e.g. if your board's "ready to work on" columns are "Not started" and
   "Backlog":
   ```bash
   delegaitor plan --notion-db <database-id> --notion-status "Not started,Backlog" --repo owner/repo
   ```
   Every team/board names these differently ("To do", "Ready", "Backlog",
   etc.), so there's no built-in default — check the actual values in your
   Notion database's Status column and use those exact strings.
6. **If it resolves 0 tickets but you expect some**, check in this order:
   - Option B only: the integration is actually connected to that
     database (its step 4).
   - Your property names match the defaults, or you've supplied overrides
     (step 2 above).
   - Your `--notion-status` values (step 5 above) exactly match the
     Status column's text, including capitalization.
   - The shared-token gotcha below — the most common cause when a whole
     team uses one Internal-integration secret (Option B).
   - Run with `--all` temporarily to confirm the database/connection
     itself works before debugging the assignee/status filters
     specifically: `delegaitor plan --notion-db <database-id> --all --repo owner/repo`.

**Assignee resolution, and the one remaining gotcha:** PATs (Option A) and
OAuth tokens (Option C) are inherently tied to you personally, so the
default "assigned to me" filter always works automatically for them — no
extra setup, no flags needed. Internal-integration secrets (Option B) are
different: they belong to a *bot* user, not to you personally, and the
Person property references real workspace members, not bots. delegAItor
resolves this automatically when the integration has a single personal
owner (Notion tells us who that is). The one case it *can't* resolve
automatically is when **your whole team shares one Internal-integration
secret** — there's no API-level way to tell which teammate is running it,
so the filter falls back to the bot's own id and silently returns zero
tickets. Fix it by passing your own Notion user id explicitly:
```bash
delegaitor dispatch --notion-db <database-id> --notion-assignee-id <your-notion-user-id> --repo owner/repo
```
Find your Notion user id by opening any page you're already assigned to
and reading the `people` property's `id` via the API, or by asking a
teammate with workspace-admin access to look it up for you. (Switching
that team to Option A or C sidesteps this entirely, since both are
already scoped to one person.)

### Setting up Linear

1. **Create a personal API key**:
   - In Linear, click your workspace name (top-left) → **Settings**.
   - Go to **Security & access** → **Personal API keys** (under "My
     account" in some Linear versions).
   - Click **Create key**, give it a label, and copy the generated key
     immediately — Linear only shows it once.
2. **Export it and preview**:
   ```bash
   export LINEAR_API_KEY=lin_api_xxx
   delegaitor plan --linear --repo owner/repo
   # optionally scope to one team:
   delegaitor plan --linear --linear-team ENG --repo owner/repo
   ```
   Find a team's key (e.g. `ENG`) from any of its issue identifiers
   (`ENG-123`) or in Linear's team settings page.
3. Because a personal API key is tied to your own Linear account, the
   default "assigned to me" filter (`assignee.isMe`) works automatically —
   no extra id lookup needed, unlike Notion.
4. **Restrict to specific workflow states** with `--linear-status`
   (optional — default is any non-completed/non-canceled state): pass a
   comma-separated list of state names exactly as they appear on your
   team's board, e.g.:
   ```bash
   delegaitor plan --linear --linear-status "Backlog,Todo" --repo owner/repo
   ```
   Every team can rename/reorder its own workflow states, so check yours
   under the team's **Settings → Workflow** page for the exact names.
5. This adapter has not been exercised against a live Linear account in
   this codebase (no test account was available while building it) — the
   query follows Linear's documented GraphQL schema, but **run `plan`
   first** and inspect the output before `dispatch`. If it errors, the
   error message includes Linear's raw GraphQL error text to help debug.

### Setting up Jira

1. **Create an API token**:
   - Go to
     [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
   - Click **Create API token**, give it a label, and copy it — this is
     your `JIRA_API_TOKEN`. It won't be shown again.
2. **Gather the other two values**:
   - `JIRA_BASE_URL`: your Jira Cloud site, e.g.
     `https://your-domain.atlassian.net` (no trailing slash).
   - `JIRA_EMAIL`: the email address of your Atlassian account (the one
     the API token belongs to).
3. **Export them and preview**:
   ```bash
   export JIRA_BASE_URL=https://your-domain.atlassian.net
   export JIRA_EMAIL=you@example.com
   export JIRA_API_TOKEN=xxx
   delegaitor plan --jira-project ENG --repo owner/repo
   ```
   Find your project key (e.g. `ENG`) from any of its issue keys
   (`ENG-123`) or Jira's project settings page.
4. `assignee = currentUser()` uses whichever account the API token/email
   pair belongs to, so "assigned to me" works automatically without any
   extra id lookup.
5. **Restrict to specific statuses** with `--jira-status` (optional —
   default is `statusCategory != Done`): pass a comma-separated list of
   status names exactly as they appear on your board, e.g.:
   ```bash
   delegaitor plan --jira-project ENG --jira-status "Selected for Development,In Refinement" --repo owner/repo
   ```
   Jira workflows are fully custom per-project, so check your project's
   board columns/workflow statuses for the exact names. Ignored if you
   also pass `--jira-jql`.
6. **Safety guard**: passing `--all` without `--jira-project` throws
   instead of silently querying your entire Jira instance — you must
   either keep the default assignee scoping, or supply a project when
   opting out of it. Use `--jira-jql` instead if you need a fully custom
   query (it overrides the built-in default/mine query entirely, and
   bypasses the project-required guard).
6. This adapter has not been exercised against a live Jira instance in
   this codebase — the query follows Jira Cloud's documented REST v3
   schema, but **run `plan` first** and inspect the output before
   `dispatch`.

### "Not all tickets are yours" — assignee scoping on shared boards

Notion, Linear, and Jira boards are usually shared across a whole team, so
by default all three are scoped to **assigned to you only**:

- Notion: server-side `people.contains` filter on the assignee property.
- Linear: `assignee: { isMe: { eq: true } }` GraphQL filter.
- Jira: `assignee = currentUser()` JQL clause (and Jira additionally
  *requires* a `--jira-project` if you opt out of this, so `--all` can't
  accidentally scan your entire Jira instance).

Pass `--all` to pull every open/ready ticket on the board instead. Either
way, explicitly naming a ticket's title, id, or URL in the input text always
resolves that specific ticket regardless of assignee — explicit mention is
treated as explicit intent.

Linear/Jira tokens are tied to your own account, so `isMe`/`currentUser()`
just work automatically. Notion is different — see the assignee-resolution
gotcha in "Setting up Notion" above (shared/workspace-owned integration
tokens need `--notion-assignee-id`).

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
