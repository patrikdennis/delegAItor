---
name: close-ticket
description: 'Close a finished delegAItor ticket: remove its git worktree, delete its local and remote branch, mark the session done, move the board card (Notion/Linear/Jira) to done, and close its cmux tab. Use when the user says a ticket is merged/finished and asks to close it, clean it up, or get rid of its worktree/branch.'
argument-hint: 'Optional: a ticket id, session id, PR number, or branch name. Defaults to the ticket for the current worktree.'
---

# Close a delegAItor ticket

Closes a ticket whose work has landed. Everything is done by one call,
`delegaitor_ticket_close` (MCP tool from the `delegaitor` server), which is
safe to re-run: steps already done by hand are reported as "already gone".

## 1. Work out which ticket

In order of preference:

1. An id the user gave (ticket id like `3e2e988f-…`, or a session id).
2. The current worktree: if the cwd is under `~/.delegaitor/worktrees/<repo>/<ticket-id>`,
   the last path segment is the ticket id.
3. A branch name: pass it as `ref` directly. For a PR number, call
   `delegaitor_overview` and match `pullRequest.number`.
4. Otherwise call `delegaitor_overview`. Entries with `next: "close"` have a
   merged PR. If there's exactly one, suggest it; otherwise ask which.

## 2. Preview

Call `delegaitor_ticket_close` with `{ "ref": "<id>", "dryRun": true }`.

- If it returns an error saying the pull request is still open, the work isn't
  merged, or the worktree has uncommitted changes, **stop and tell the user**.
  Only retry with `force: true` if the user explicitly says to discard the
  work. Never force on your own.
- Otherwise show the user the planned steps (worktree, local branch, remote
  branch, board, cmux tab).

## 3. Close

Call `delegaitor_ticket_close` with `{ "ref": "<id>" }`. Add:

- `keepRemote: true` if the user wants to keep the remote branch.
- `keepTab: true` if you are running inside the ticket's own cmux tab and the
  user hasn't asked for the tab to be closed. Closing the tab ends this session,
  so if you close it, write your summary to the user **before** the call.
- `summary` if the user gave one. By default it's "Merged as PR #N" when a
  merged PR is found.

## 4. Report

Summarize each step's result (`done`, `already gone`, `skipped`, `failed`)
and the `boardStatus`:

- `boardStatus.ok: true`: the card was moved to that column.
- `boardStatus.ok: false`: quote the error verbatim (it lists the valid column
  names). The user can fix and retry with `delegaitor_ticket_move`
  (`stage: "done"`).
- `boardStatus` missing: no done column was configured at dispatch
  (`--move-on-done`), so the card was not moved. Say so plainly.

## If the MCP tool isn't available

Use the CLI instead, same options:

```bash
delegaitor ticket close <id> --dry-run
delegaitor ticket close <id> [--keep-remote] [--keep-tab] [--summary "..."] [--force]
```

If running shell commands is denied too, give the user the exact command to
run themselves.
