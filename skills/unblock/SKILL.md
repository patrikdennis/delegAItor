---
name: unblock
description: 'Unblock delegAItor agents that are waiting on the user: find blocked sessions, show what each one asked, collect the user''s answers, and send them into each agent''s cmux tab so it continues. Use when the user says "unblock my agents", "what are they waiting for", "answer the blocked tickets", or a ticket shows as blocked.'
argument-hint: 'Optional: a ticket id or session id to unblock just one.'
---

# Unblock agents

## 1. Find who's waiting

Call `delegaitor_overview` and take entries whose `next` is `unblock`,
`address review` or `check`. If the user named one ticket, just that one.
If there are none, say so (and mention any `unread` messages between
sessions, which the agents handle themselves).

## 2. Work out each question

For each entry:
- The `summary` is usually the agent's reason for blocking.
- For more context, call `delegaitor_session_screen` with its `sessionId`
  (e.g. `lines: 60`) to read what the agent last said. Skip lines that are
  just tool output.
- `address review`: the PR has requested changes. Fetch the review comments
  with `gh pr view <number> --comments` if you can.
- `check`: the session failed. The screen usually shows why.

If you can answer a question yourself from the repository (e.g. "which
file holds the export logic?"), draft that answer, but still show it to the
user. Product and design decisions are the user's.

## 3. Ask the user

Present all waiting tickets at once: title, the question in one or two
sentences, and your suggested answer if you have one. Collect answers for
all of them in one round, using a form with one field per ticket if your
tools support it.

## 4. Send the answers

For each answered ticket, call `delegaitor_session_nudge` with
`{ "ref": "<sessionId>", "text": "<answer>" }`. Write the text as a direct
instruction to the agent, self-contained, one paragraph (newlines are sent
as spaces). For `address review`, list the changes to make.

The call marks a blocked session running again and moves its card back to
in progress, if configured. Report which sessions were resumed.

Tickets the user skipped stay blocked; mention them at the end.

If the nudge fails with a cmux "Access denied" error, this session isn't
running inside cmux. Give the user the command to run from a cmux tab:
`delegaitor session nudge <sessionId> "<answer>"`.
