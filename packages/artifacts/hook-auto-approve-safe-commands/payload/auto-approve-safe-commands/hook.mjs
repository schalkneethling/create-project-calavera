#!/usr/bin/env -S node
/**
 * auto-approve-safe-commands: PermissionRequest hook
 *
 * Reads a Claude Code hook payload from stdin, inspects tool_input.command,
 * and allows safe commands that match known-safe patterns.
 *
 * Exit 0  = defers to permission prompt
 */
import { readFileSync } from "node:fs";
// --- Safe command patterns ---
//
// Each entry is a pattern and a label for logging purposes.
// Order matters — more specific patterns should come before broader ones.
const SAFE_PATTERNS = [
    // Test runners
    { pattern: /^npm\s+test\b/, label: "npm test" },
    { pattern: /^npx\s+vitest\b/, label: "vitest" },
    { pattern: /^vp\s+test\b/, label: "vp test" },
    { pattern: /^pnpm\s+test\b/, label: "pnpm test" },
    { pattern: /^yarn\s+test\b/, label: "yarn test" },
    { pattern: /^bun\s+test\b/, label: "bun test" },
    { pattern: /^jest\b/, label: "jest" },
    { pattern: /^vitest\b/, label: "vitest (direct)" },
    // Linting and formatting (analysis only, never destructive)
    { pattern: /^npm\s+run\s+lint\b/, label: "npm run lint" },
    { pattern: /^pnpm\s+run\s+lint\b/, label: "pnpm run lint" },
    { pattern: /^yarn\s+lint\b/, label: "yarn lint" },
    { pattern: /^bun\s+run\s+lint\b/, label: "bun run lint" },
    { pattern: /^eslint\b/, label: "eslint" },
    { pattern: /^prettier\s+--check\b/, label: "prettier --check" },
    { pattern: /^stylelint\b/, label: "stylelint" },
    // Type checking
    { pattern: /^tsc\s+--noEmit\b/, label: "tsc --noEmit" },
    { pattern: /^npx\s+tsc\s+--noEmit\b/, label: "npx tsc --noEmit" },
    { pattern: /^npm\s+run\s+typecheck\b/, label: "npm run typecheck" },
    { pattern: /^pnpm\s+run\s+typecheck\b/, label: "pnpm run typecheck" },
    { pattern: /^bun\s+run\s+typecheck\b/, label: "bun run typecheck" },
    // Build commands
    { pattern: /^npm\s+run\s+build\b/, label: "npm run build" },
    { pattern: /^pnpm\s+run\s+build\b/, label: "pnpm run build" },
    { pattern: /^yarn\s+build\b/, label: "yarn build" },
    { pattern: /^bun\s+run\s+build\b/, label: "bun run build" },
    { pattern: /^vite\s+build\b/, label: "vite build" },
    { pattern: /^tsc\b/, label: "tsc" },
    // Vite+ (vp) commands - https://viteplus.dev/guide/#core-commands
    { pattern: /^vp\s+test\b/, label: "vp test" },
    { pattern: /^vp\s+check\b/, label: "vp check" },
    { pattern: /^vp\s+lint\b/, label: "vp lint" },
    { pattern: /^vp\s+fmt\b/, label: "vp fmt" },
    { pattern: /^vp\s+build\b/, label: "vp build" },
    { pattern: /^vp\s+dev\b/, label: "vp dev" },
    { pattern: /^vp\s+preview\b/, label: "vp preview" },
    { pattern: /^vp\s+run\b/, label: "vp run" },
    { pattern: /^vp\s+outdated\b/, label: "vp outdated" },
    { pattern: /^vp\s+why\b/, label: "vp why" },
    { pattern: /^vp\s+info\b/, label: "vp info" },
    { pattern: /^vpx\b/, label: "vpx" },
    // Dev server
    { pattern: /^npm\s+run\s+dev\b/, label: "npm run dev" },
    { pattern: /^pnpm\s+run\s+dev\b/, label: "pnpm run dev" },
    { pattern: /^yarn\s+dev\b/, label: "yarn dev" },
    { pattern: /^bun\s+run\s+dev\b/, label: "bun run dev" },
    { pattern: /^vite\b/, label: "vite" },
    // Git read operations (no side effects)
    { pattern: /^git\s+status\b/, label: "git status" },
    { pattern: /^git\s+log\b/, label: "git log" },
    { pattern: /^git\s+diff\b/, label: "git diff" },
    { pattern: /^git\s+branch\b/, label: "git branch" },
    { pattern: /^git\s+show\b/, label: "git show" },
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
const DESTRUCTIVE_OPTIONS = /(?:^|\s)(?:--force|--fix|--write|--delete|-delete|-f|-r|-R|-rf|-fr|--recursive)(?:\s|$)/;
const COMMAND_SPECIFIC_UNSAFE_PATTERNS = [
    /^git\s+branch\s+-(?:d|D)\b/,
    /^find\b.*\s-exec(?:dir)?\b.*(?:\+|\\;)\s*$/,
];
// --- Helpers ---
function isSafeCommandShape(command) {
    return (!UNSAFE_SHELL_SYNTAX.test(command) &&
        SAFE_COMMAND_WORDS.test(command) &&
        !DESTRUCTIVE_OPTIONS.test(command) &&
        !COMMAND_SPECIFIC_UNSAFE_PATTERNS.some((pattern) => pattern.test(command)));
}
function approve() {
    const output = {
        hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
                behavior: "allow",
            },
        },
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(0);
}
function defer() {
    // Exit 0 with no output — falls through to the normal permission prompt
    process.exit(0);
}
// --- Main ---
function main() {
    const raw = readFileSync("/dev/stdin", "utf-8").trim();
    let input;
    try {
        input = JSON.parse(raw);
    }
    catch {
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
    const { command } = input.tool_input;
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
main();
