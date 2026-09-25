import { execa } from "execa";
import { renderShellCommand, type AgentCommand } from "./runtimes.js";

export interface LaunchTarget {
  worktreePath: string;
  title: string;
}

export interface LaunchResult {
  method: "cmux" | "detached-terminal";
  cmuxWorkspaceId?: string;
  pid?: number;
}

/**
 * Launches an agent session for a ticket. Prefers cmux (one workspace per
 * ticket, named after it, visible in the sidebar with notifications) and
 * falls back to a detached background process if cmux isn't running,
 * e.g. in CI or on a machine without cmux installed.
 */
export async function launchSession(cmd: AgentCommand, target: LaunchTarget): Promise<LaunchResult> {
  const cmuxAvailable = await hasCmux();
  if (cmuxAvailable) {
    const workspaceId = await openCmuxWorkspace(cmd, target);
    if (workspaceId) return { method: "cmux", cmuxWorkspaceId: workspaceId };
  }

  const child = execa(cmd.command, cmd.args, {
    cwd: target.worktreePath,
    detached: true,
    stdio: "ignore",
    shell: true,
  });
  child.unref();
  return { method: "detached-terminal", pid: child.pid };
}

export async function closeCmuxWorkspace(workspaceId: string): Promise<void> {
  await execa("cmux", ["close-workspace", "--workspace", workspaceId]).catch(() => {
    /* workspace may already be closed by the user */
  });
}

export async function notifyCmux(title: string, body: string): Promise<void> {
  await execa("cmux", ["notify", "--title", title, "--body", body]).catch(() => {
    /* cmux not running; notification is best-effort */
  });
}

async function hasCmux(): Promise<boolean> {
  try {
    await execa("cmux", ["ping"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a workspace with `cmux new-workspace`, which returns "OK workspace:<n>"
 * on stdout, then renames it after the ticket since new-workspace has no
 * --title flag of its own.
 */
async function openCmuxWorkspace(cmd: AgentCommand, target: LaunchTarget): Promise<string | null> {
  try {
    const { stdout } = await execa("cmux", [
      "new-workspace",
      "--cwd",
      target.worktreePath,
      "--command",
      renderShellCommand(cmd),
    ]);
    const workspaceId = stdout.trim().split(/\s+/).pop() ?? null;
    if (workspaceId) {
      await execa("cmux", ["rename-workspace", "--workspace", workspaceId, target.title]).catch(
        () => {
          /* rename is cosmetic; ignore failures */
        },
      );
    }
    return workspaceId;
  } catch {
    return null;
  }
}
