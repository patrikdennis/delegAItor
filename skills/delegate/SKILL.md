---
name: delegate
description: 'Delegate tickets with delegAItor: pull them from a board (Notion/Linear/Jira/GitHub) or a pasted list, preview branches, and dispatch one agent per ticket in its own worktree and cmux tab. Use when the user says "delegate my tickets", "start my Not started tickets", "dispatch these", or pastes several tickets to work in parallel. Also sets up saved profiles so this is one step next time.'
argument-hint: 'Optional: a profile name (e.g. "sales-engine"), a board/status to pull from, or a list of tickets.'
---

# Delegate tickets

Uses the `delegaitor` MCP tools. Dispatching opens cmux tabs, which only
works when this session itself runs inside cmux.

## 1. Pick the source

- **Pasted tickets** (a list, issue refs like `#123`, URLs): pass them as
  `text`. A profile can still supply the repo, agent and board statuses.
- **A board**: use a saved profile. Call `delegaitor_profile_list`.
  - One profile clearly matches what the user asked for (by name or
    description): use it.
  - Several could match: ask which.
  - None: go to "Create a profile" below, then come back.

## 2. Preview

Call `delegaitor_plan` with `{ "profile": "<name>" }` (plus `text` if the user
listed tickets, and any override they asked for, e.g. `agent`, or
`notionStatuses` for a different column).

Show the user a short table: ticket title, branch, and the prefix reason.
Point out:
- tickets flagged in `conflictsWith` (they may touch the same files),
- 0 tickets: the filters are probably wrong. Check the status/project names
  with the user before changing them. Never switch to `all: true` without
  asking, since that pulls every teammate's tickets too.

## 3. Dispatch

Only after the user confirms, call `delegaitor_dispatch` with the same
arguments. Report per ticket: session id, `launchMethod`, and `boardStatus`.

- `launchMethod: "detached-terminal"` means no cmux tab opened (this session
  isn't inside cmux). Tell the user to run it from a cmux tab instead:
  `delegaitor dispatch --profile <name>`.
- `boardStatus.ok: false`: quote the error; it lists the valid column names.

## Create a profile

Ask for what you can't find out yourself, in one go:

1. Where the tickets are: Notion database id or URL, Linear team, Jira
   project, or GitHub repo.
2. Which column(s) to pull from (e.g. "Not started"), and for shared
   multi-project boards, which project.
3. Which columns to move cards to when work starts, is ready for review, is
   blocked, and is done. Leave out any the user doesn't use.
4. The GitHub repo (`owner/repo`), its local clone path (absolute), and the
   agent (`copilot`, `claude`, ...).

For Notion, property names differ per board (e.g. the title may be `Task`,
the project a rollup like `Product Rollup`). If unsure, try a plan and
adjust from the error or empty result.

Verify with `delegaitor_plan` using the fields directly, then save with
`delegaitor_profile_save` (`name`, a one-line `description`, and the same
fields). Tell the user they can now run `delegaitor dispatch --profile <name>`
from any cmux tab.
