---
name: ticket-status
description: 'Overview of all delegAItor tickets and what each needs next: blocked agents waiting for an answer, finished work to ship, open PRs to review, merged PRs to close. Use when the user asks "what are my agents doing", "status of my tickets", "what needs my attention", or "standup summary".'
argument-hint: 'Optional: "all" to include finished tickets.'
---

# Ticket status

1. Call `delegaitor_overview` (add `includeFinished: true` if the user asked
   for everything). Multi-repo parents include per-unit status, alias, branch,
   session id, summary, and PR in `units`.
2. Present it grouped by what the user has to do, most urgent first. Skip
   empty groups:

   | Group | `next` values | Say |
   |-------|---------------|-----|
   | Waiting on you | `unblock`, `address review`, `check` | the agent's `summary` (usually its question) |
   | Ready to ship | `ship` | work is done but has no PR |
   | In review | `review` | PR link, draft or not |
   | Ready to close | `close` | PR merged |
   | Working | `working` | one line each; mention unread messages or held locks |

   Use the ticket title, not the id, as the label. Keep ids available in
   case the user wants to act on one.
3. End with the concrete next steps, pointing at the skill for each:
   `unblock` for waiting agents, `ship-ticket`, `review-ticket`,
   `close-ticket`. For multi-repo tickets, act on each unit's session id;
   parent board transitions are aggregated. If several tickets are ready to
   close, offer to close them all, previewing every unit first.

If `delegaitor_overview` returns nothing, say there are no open delegated
tickets and suggest the `delegate` skill.

For a standup-style summary, write it as short prose per group instead of
a table: what finished, what's in review, what's blocked and on what.
