#!/usr/bin/env -S node

/**
 * auto-approve-safe-commands: PermissionRequest hook
 *
 * Reads a Claude Code hook payload from stdin, inspects tool_input.command,
 * and allows safe commands that match known-safe patterns.
 *
 * Exit 0  = defers to permission prompt
 */

// --- Types ---

interface BashToolInput {
  command: string;
}

interface PermissionRequestInput {
  hook_event_name: "PermissionRequest";
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_name: string;
  tool_input: BashToolInput | Record<string, unknown>;
}

interface ApproveOutput {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow";
    };
  };
}

// --- Safe command patterns ---
//
// Each entry is a pattern and a label for logging purposes.
// Order matters — more specific patterns should come before broader ones.

const SAFE_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Git read operations (no side effects)
  { pattern: /^git\s+status(?:\s+--(?:short|branch|porcelain(?:=v[12])?))*$/, label: "git status" },
  { pattern: /^git\s+log(?:\s+--oneline)?$/, label: "git log" },
  {
    pattern: /^git\s+diff(?:\s+--(?:stat|name-only|name-status|check|cached|staged))*$/,
    label: "git diff",
  },
  { pattern: /^git\s+branch(?:\s+--show-current)?$/, label: "git branch" },
  { pattern: /^git\s+show(?:\s+--(?:stat|oneline))?$/, label: "git show" },

  // Filesystem reads
  { pattern: /^cat\b/, label: "cat" },
  { pattern: /^ls\b/, label: "ls" },
  { pattern: /^find\b/, label: "find" },
  { pattern: /^grep\b/, label: "grep" },
  { pattern: /^rg\b/, label: "ripgrep" },

  // Environment checks
  { pattern: /^node\s+--version\b/, label: "node --version" },
  { pattern: /^node\s+-v\b/, label: "node -v" },
  { pattern: /^bun\s+--version\b/, label: "bun --version" },
  { pattern: /^npm\s+--version\b/, label: "npm --version" },
  { pattern: /^git\s+--version\b/, label: "git --version" },
];

const UNSAFE_SHELL_SYNTAX = /[;&|<>`]|\$\(|\r|\n/;
const SAFE_COMMAND_WORDS = /^[\w@%+=:,./\s-]+$/;
const DESTRUCTIVE_OPTIONS =
  /(?:^|\s)(?:--force|--fix|--write|--delete|-delete|-f|-r|-R|-rf|-fr|--recursive)(?:\s|$)/;

const COMMAND_SPECIFIC_UNSAFE_PATTERNS = [
  /^git\s+branch\s+-(?:d|D)\b/,
  /^find\b.*\s-exec(?:dir)?\b.*(?:\+|\\;)\s*$/,
];

// --- Helpers ---

function isSafeCommandShape(command: string): boolean {
  return (
    !UNSAFE_SHELL_SYNTAX.test(command) &&
    SAFE_COMMAND_WORDS.test(command) &&
    !DESTRUCTIVE_OPTIONS.test(command) &&
    !COMMAND_SPECIFIC_UNSAFE_PATTERNS.some((pattern) => pattern.test(command))
  );
}

function approve(): void {
  const output: ApproveOutput = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
      },
    },
  };

  process.stdout.write(JSON.stringify(output) + "\n");
  process.exitCode = 0;
}

function defer(): void {
  // Exit 0 with no output — falls through to the normal permission prompt
  process.exitCode = 0;
}

// --- Main ---

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();

  let input: PermissionRequestInput;

  try {
    input = JSON.parse(raw) as PermissionRequestInput;
  } catch {
    process.stderr.write(`[auto-approve-safe-commands] Failed to parse stdin JSON\n`);
    defer();
    return;
  }

  // Only handle Bash tool permission requests
  if (input.tool_name !== "Bash") {
    defer();
    return;
  }

  if (typeof input.tool_input !== "object" || input.tool_input === null) {
    defer();
    return;
  }

  const { command } = input.tool_input as BashToolInput;

  if (typeof command !== "string") {
    defer();
    return;
  }

  const trimmed = command.trim();

  if (!isSafeCommandShape(trimmed)) {
    defer();
    return;
  }

  for (const { pattern, label } of SAFE_PATTERNS) {
    if (pattern.test(trimmed)) {
      process.stderr.write(`[auto-approve-safe-commands] Auto-approved: ${label}\n`);
      approve();
      return;
    }
  }

  // Not on the allowlist — fall through to normal permission prompt
  defer();
}

main().catch(() => defer());
