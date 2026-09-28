import { execa } from "execa";
import { getDb } from "./db.js";
import { findSession } from "./sessions.js";
import { sendMessage } from "./sync/messages.js";
import { syncBoardStatus, type BoardStatusResult } from "./tickets/board-status.js";

function requireWorkspace(ref: string) {
  const s = findSession(ref);
  if (!s.cmuxWorkspaceId) {
    throw new Error(
      `Session ${s.sessionId} has no cmux tab (it was launched as a detached process), so it can't be read or messaged directly.`,
    );
  }
  return s;
}

async function cmux(args: string[]): Promise<string> {
  try {
    return (await execa("cmux", args)).stdout;
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    if (/Access denied/i.test(msg)) {
      throw new Error("cmux only accepts commands from processes started inside cmux; run this from a cmux tab.");
    }
    throw new Error(`cmux ${args[0]} failed: ${msg}`);
  }
}

/** The last `lines` lines of the session's terminal, e.g. to see the question a blocked agent asked. */
export async function readSessionScreen(ref: string, lines = 80): Promise<string> {
  const s = requireWorkspace(ref);
  return cmux(["read-screen", "--workspace", s.cmuxWorkspaceId!, "--lines", String(lines)]);
}

export interface NudgeResult {
  sessionId: string;
  ticketId: string;
  resumed: boolean;
  boardStatus?: BoardStatusResult;
}

/**
 * Types `text` into the session's agent prompt and presses Enter, the same
 * as if you'd switched to its tab and replied. A blocked session is marked
 * running again (and its card moved back to the in-progress column, if one
 * is configured). The text is also stored as a message on the ticket, so
 * there's a record of the answer.
 */
export async function nudgeSession(ref: string, text: string, opts: { resume?: boolean } = {}): Promise<NudgeResult> {
  const s = requireWorkspace(ref);
  // cmux send turns a literal \n, \r or \t into a key press and has no escape for it, so swap the backslash
  // for a look-alike (∖) in just those sequences. Other backslashes arrive unchanged.
  const oneLine = text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\\(?=[nrt])/g, "\u2216")
    .trim();
  if (!oneLine) throw new Error("Nothing to send.");
  await cmux(["send", "--workspace", s.cmuxWorkspaceId!, "--", oneLine]);
  await cmux(["send-key", "--workspace", s.cmuxWorkspaceId!, "enter"]);

  sendMessage({ fromSessionId: "user", toSessionId: s.sessionId, toTicketId: s.ticketId, body: text, kind: "answer" });

  const result: NudgeResult = { sessionId: s.sessionId, ticketId: s.ticketId, resumed: false };
  if ((opts.resume ?? true) && s.sessionStatus === "blocked") {
    const db = getDb();
    db.prepare(`UPDATE sessions SET status = 'running', ended_at = NULL WHERE id = ?`).run(s.sessionId);
    db.prepare(`UPDATE tickets SET status = 'dispatched', updated_at = datetime('now') WHERE id = ?`).run(s.ticketId);
    result.resumed = true;
    result.boardStatus = await syncBoardStatus(s.ticketId, "in_progress");
  }
  return result;
}
