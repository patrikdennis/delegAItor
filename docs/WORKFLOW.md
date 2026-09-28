# delegAItor workflow

The day-to-day loop, from "tickets on a board" to "merged and cleaned up".
Examples use a profile called `my-board`; swap in your own names.

Wherever a command takes `<ticket>` you can pass a ticket id, a session id,
a branch name, or the first 6+ characters of a session or ticket id.

## 0. One-time setup

1. Install and link delegAItor (see the [README](../README.md#install)),
   then install the skills and the `ticket-worker` agent
   ([Installing the skills](../README.md#installing-the-skills)).
2. Store your board credentials once, from a **cmux tab**:
   ```bash
   delegaitor auth set NOTION_API_KEY    # or LINEAR_API_KEY, JIRA_API_TOKEN, ...
   delegaitor auth list
   ```
   Agent sessions read them from `$DELEGAITOR_HOME/credentials.json`, so
   they can move board cards too.
3. Optional: describe your team's branch prefixes in
   `<repo>/.delegaitor/branch-prefixes.json` (see
   [Branch prefixes](../README.md#branch-prefixes)). Without it the prefixes
   are detected from the repo's existing branches.

## 1. Save a profile per board

A profile is the long `dispatch` command saved under a name. Save it from
the repo's clone so its local path is stored too:

```bash
cd ~/code/my-repo
delegaitor profile save my-board --description "My team board, Not started" \
  --notion-db <database-id> --notion-title-prop "Task" \
  --notion-project-prop "Project Rollup" --notion-project "Q3 launch" \
  --notion-status "Not started" \
  --repo owner/my-repo --agent copilot \
  --move-on-dispatch "In progress" --move-on-review "Ready for review" --move-on-done "Done"
```

Use the exact property and column names from your board. A wrong column
name doesn't stop a dispatch: the card move fails with a message that lists
the valid names.

Managing profiles:

| Want to | Run |
|---|---|
| See all profiles | `delegaitor profile list` |
| See one | `delegaitor profile show my-board` |
| Change one field | `delegaitor profile save my-board --merge --notion-status "Backlog"` |
| Replace it | `delegaitor profile save my-board <all flags>` (without `--merge`) |
| Add a second board | `delegaitor profile save other-board <its flags>` |
| Override once, without saving | `delegaitor plan --profile my-board --agent claude` |
| Delete one | `delegaitor profile remove my-board` |

`--merge` keeps every field you don't pass. Passing a flag as `""` (e.g.
`--notion-project ""`) clears that field.

## 2. Dispatch

From a cmux tab (cmux only accepts commands from processes it started):

```bash
delegaitor plan --profile my-board        # preview: tickets, branches, conflicts
delegaitor dispatch --profile my-board    # confirm with y
```

Each ticket gets its own worktree, a branch named after your conventions
(`fix/`, `feature/`, ...), and a cmux tab with an agent already working.
The board card moves to your in-progress column.

Or tell any agent: "delegate my my-board tickets" (`delegate` skill).

Dispatch doesn't skip tickets that already have a running session. It relies
on the in-progress column moving them out of the filter. If a ticket was
dispatched without board moves, move its card by hand first, or answer `N`.

## 3. Check in

```bash
delegaitor overview
```

It lists every open ticket with what it needs next:

| Next | Meaning | Do |
|---|---|---|
| `UNBLOCK` | The agent asked a question | Step 4 |
| `SHIP` | Work done, not pushed or no PR yet | Step 5 |
| `ADDRESS REVIEW` | PR has requested changes | Tell the agent in its tab |
| `REVIEW` | PR is open | Step 6 |
| `CLOSE` | PR is merged | Step 7 |
| `CHECK` | The session failed | Look at its tab |
| `WORKING` | Agent is busy | Nothing |

Or ask: "what are my agents doing?" (`ticket-status` skill).

## 4. Unblock a stuck agent

```bash
delegaitor session screen <ticket>                     # see what it asked
delegaitor session nudge <ticket> "Use CSV, like the existing export"
```

`nudge` types your answer into the agent's tab, presses Enter, and moves a
blocked session back to running. Or: "unblock my agents" (`unblock` skill),
which collects the questions and relays your answers.

## 5. Ship

In the ticket's tab, say "ship it" (`ship-ticket` skill), or:

```bash
delegaitor ticket ship <ticket> --dry-run   # preview
delegaitor ticket ship <ticket>             # push, open PR, card -> review
```

It refuses when there are uncommitted changes or no commits, and never
force-pushes. If a PR is already open, it reuses it.

If the branch prefix is wrong and the branch isn't pushed yet:
`delegaitor session rename-branch --session <id> --prefix fix/`.

## 6. Review

"review ticket <id>" (`review-ticket` skill) reads the ticket and the diff
and reports whether the change does what the ticket asks. By hand:

```bash
delegaitor ticket context <ticket>          # ticket text, commits, diff
```

## 7. Close after merge

Close from outside the worktree, since the command removes it:

```bash
cd ~
delegaitor ticket close <ticket> --dry-run
delegaitor ticket close <ticket>
```

It removes the worktree, deletes the local and remote branch, marks the
session done (card -> Done), and closes the tab. It refuses when the PR is
still open or the work isn't merged, unless you pass `--force`. Re-running
is safe. Or: "close the ... ticket" (`close-ticket` skill).

To tidy up several finished tickets at once:
`delegaitor cleanup --delete-remote --dry-run`, then without `--dry-run`.

## 8. Next batch

Go back to step 2. Tickets you've already dispatched have left the
"Not started" column, so only new ones come up.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cmux: Access denied` | Run delegAItor from a cmux tab, not another terminal |
| Tabs didn't open | Same as above. Sessions ran detached; `delegaitor status` lists them |
| Card didn't move | `delegaitor auth list` for the key; the error lists valid column names; retry with `delegaitor ticket move --ticket <id> --stage ready_for_review` |
| Plan finds 0 tickets | Check the status/project names are exact; see [Ticket sources](../README.md#ticket-sources) |
| Agent can't run `delegaitor` | Its shell was denied; use the MCP tools (skills do) or run the command yourself |
| New skills/tools missing in a session | Restart that session; only new sessions load them |
| `matches more than one ticket` | Use more characters of the id |
