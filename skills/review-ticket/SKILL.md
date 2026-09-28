---
name: review-ticket
description: 'Review a delegAItor ticket''s changes against the ticket itself: checks the diff covers every requirement and point from the ticket discussion, and looks for bugs, missing tests and unrelated changes. Use when the user asks to review a ticket, check an agent''s work, or "is this ready to merge" for a delegated ticket.'
argument-hint: 'Optional: a ticket id, session id, branch or PR. Defaults to the ticket for the current worktree.'
---

# Review a ticket

This is a read-only review. Don't change code or post on the PR unless the
user asks.

## 1. Gather

Find the ticket as in the other delegAItor skills (cwd under
`~/.delegaitor/worktrees/.../<ticket-id>`, an id the user gave, or
`delegaitor_overview` entries with `next: review`).

Call `delegaitor_ticket_context` with `{ "ref": "<id>" }`. If
`diffTruncated` is true, read the remaining files directly from the
worktree or with `git diff` for the files in `diffStat`.

Also read the repository's own review guidance if present (AGENTS.md,
CONTRIBUTING, `.github/copilot-instructions.md`, CLAUDE.md).

## 2. Check against the ticket

Break the ticket `body` (including any discussion or comments it contains)
into concrete requirements and acceptance criteria. For each, decide:
done, partly done, or missing, and cite the file and line that shows it.

Then look for:
- bugs and edge cases the change introduces (empty lists, paging, errors,
  permissions, locale, time zones),
- missing or weak tests for the changed behavior,
- changes unrelated to the ticket (scope creep), and leftover debug code,
- `uncommitted` files that look like they belong in the change.

Skip style nits unless the repo's guidance asks for them.

## 3. Report

Start with a verdict: **ready to merge**, **needs changes**, or **needs a
decision** (the ticket is ambiguous).

Then list requirements (✅ / ⚠️ / ❌ with evidence), followed by findings
ordered by severity, each with the file:line and a suggested fix.

## 4. Offer follow-ups

- **Send the findings to the ticket's agent** so it fixes them: with the
  user's OK, call `delegaitor_session_nudge` with the ticket's session and
  a short, numbered list of what to fix. This types it into the agent's tab.
- **Post as a PR review**, if the user asks: `gh pr review <number>
  --comment --body "..."` (or `--request-changes`).
- Ready to merge: remind the user to merge, then use `close-ticket`.
