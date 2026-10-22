---
name: ship-ticket
description: 'Ship a delegAItor ticket: make sure the work is committed, push its branch, and open a pull request with a proper description and a link to the ticket, then mark it ready for review so the board card moves. Use when the user says "ship it", "open a PR", "push this ticket", or "make a pull request" for a delegated ticket.'
argument-hint: 'Optional: a ticket id, session id or branch. Defaults to the ticket for the current worktree.'
---

# Ship a ticket

## 1. Find the ticket

- If the cwd is under `~/.delegaitor/worktrees/<repo>/<ticket-id>`, the last
  path segment is the ticket id.
- Otherwise use the id the user gave, or call `delegaitor_overview` and pick
  the ticket whose `next` is `ship` (ask if there are several).
- For a multi-repository ticket, use its one parent session id. The context
  result includes each repo's commits, diff, and uncommitted files.

## 2. Check the work

Call `delegaitor_ticket_context` with `{ "ref": "<session-id>" }` once.

- `uncommitted` is not empty: show the files and ask whether to commit them.
  Follow the repository's commit conventions (AGENTS.md,
  CONTRIBUTING, recent `git log`). Don't commit unrelated files.
- A repo with no commits/changes is skipped and reported as `no_changes`;
  other changed repos may still be shipped.
- The branch prefix doesn't fit the change (e.g. `feature/` for a bug fix)
  and the branch hasn't been pushed: offer to fix it with
  `delegaitor_branch_rename` before shipping.
- If the repo's instructions require tests or linters before a PR and you
  haven't run them this session, run them now and report the result.

## 3. Write the pull request

Read the diff and the ticket, then write:

- **Title**: what the change does, in the repo's usual style (look at recent
  merged PR titles with `gh pr list --state merged --limit 5` if you can).
- **Body**: why (the problem from the ticket, in a sentence or two), what
  changed, how it was tested, and anything reviewers should look at. Keep
  it short. A link to the ticket is added automatically.
- Use the same language as the repository's existing PRs.

Show the title and body to the user and ask for approval, unless they told
you to go ahead without asking.

## 4. Ship

After approval, call `delegaitor_ticket_ship` once with
`{ "ref": "<session-id>", "title", "body" }` (add `draft: true` if the
user asked for a draft). It rejects if any repo worktree is dirty, skips
repos with no changes, and creates/reuses PRs for changed repos. A failed PR
in any repo prevents the parent from moving to review.

Report per repo: `shipped`, `no_changes`, or `failed`, push outcome, PR link
(`created: false` means it already existed), and errors. Also report
`boardStatus` (`ok: false`: quote the error; missing: no ready-for-review
column was configured).

If `pullRequestError` is set, the branch was pushed but the PR wasn't
opened. Show the error. `gh auth status` usually explains it.

## Without MCP

`delegaitor ticket ship <id> --title "..." --body "..." [--draft] [--dry-run]`
