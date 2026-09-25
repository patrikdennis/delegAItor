import type { AgentRuntimeKind } from "../types.js";

export interface AgentCommand {
  command: string;
  args: string[];
}

/**
 * Builds the shell invocation for each supported agent runtime. Kept
 * intentionally thin: all workflow behavior (ticket scope, sync protocol,
 * validation) lives in the prompt/agent-profile, not here.
 */
export function buildAgentCommand(agent: AgentRuntimeKind, promptFile: string): AgentCommand {
  switch (agent) {
    case "claude":
      // Bare `claude "<text>"` starts an interactive, steerable session with
      // the prompt as the first message (NOT `-p`, which exits after one reply).
      return { command: "claude", args: [`"$(cat ${shellQuote(promptFile)})"`] };
    case "copilot":
      // `-i/--interactive` starts interactive mode and auto-executes the
      // prompt, leaving the session open and steerable in the cmux tab.
      // `-p/--prompt` would exit immediately after one response instead.
      return {
        command: "copilot",
        args: ["--agent=ticket-worker", "-i", `"$(cat ${shellQuote(promptFile)})"`],
      };
    case "codex":
      // Bare `codex "<text>"` opens the interactive TUI with the prompt
      // pre-run (`codex exec` would be the non-interactive equivalent).
      return { command: "codex", args: [`"$(cat ${shellQuote(promptFile)})"`] };
    case "opencode":
      // NOTE: best-effort; verify `opencode run` stays interactive in your
      // installed version before relying on this for unattended sessions.
      return { command: "opencode", args: ["run", `"$(cat ${shellQuote(promptFile)})"`] };
    default:
      throw new Error(`Unsupported agent runtime: ${agent satisfies never}`);
  }
}

/** Renders a command as a single shell string, e.g. for cmux `command` actions. */
export function renderShellCommand(cmd: AgentCommand): string {
  return [cmd.command, ...cmd.args].join(" ");
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
