#!/usr/bin/env -S node
/**
 * block-dangerous-commands: PreToolUse hook for Bash.
 *
 * Reads a Claude Code hook payload from stdin, inspects tool_input.command,
 * and blocks commands that match known-dangerous patterns.
 *
 * Exit 2  = block (with structured JSON on stdout)
 * Exit 0  = allow (including on malformed input — fail open)
 */
const rules = [
    {
        id: "rm-rf",
        test: (c) => /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(?:\s|$)/.test(c),
        message: "`rm -rf` (and flag variants) is blocked. Delete specific paths with a non-recursive `rm`, or move them to a backup location.",
    },
    {
        id: "git-push-force",
        test: (c) => /\bgit\s+push\b.*\s(?:--force(?!-with-lease)\b|-f\b)/.test(c),
        message: "`git push --force` is blocked. Use `--force-with-lease` only after coordinating with collaborators, or create a new branch.",
    },
    {
        id: "git-push-protected",
        test: (c) => /\bgit\s+push\b(?:\s+\S+)*\s+(?:origin\s+)?(?:main|master|production|prod|release)(?:\s|$)/.test(c) ||
            /\bgit\s+push\b.*\S+:(?:refs\/heads\/)?(?:main|master|production|prod|release)(?:\s|$)/.test(c),
        message: "Direct push to a protected branch (main/master/production/prod/release) is blocked. Open a pull request instead.",
    },
    {
        id: "git-reset-hard",
        test: (c) => /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/.test(c),
        message: "`git reset --hard` is blocked — it discards uncommitted work. Consider `git stash`, `git restore`, or a soft reset.",
    },
    {
        id: "chmod-777",
        test: (c) => /\bchmod\s+(?:-[a-zA-Z]*\s+)*(?:777|[ugoa]*[+=][rwx]*w[rwx]*(?:\s|$))/.test(c) &&
            /-R|--recursive|777/.test(c),
        message: "`chmod 777` or recursive world-writable chmod is blocked. Grant the minimum permissions required.",
    },
    {
        id: "dd-if",
        test: (c) => /\bdd\s+if=/.test(c),
        message: "`dd if=` is blocked — it can overwrite disks irrecoverably.",
    },
    {
        id: "system-redirect",
        test: (c) => /(?:>{1,2}\s*|tee(?:\s+-[a-zA-Z]*)?\s+)\/(?:etc|boot|usr|bin|sbin)\//.test(c),
        message: "Writing into /etc, /boot, /usr, /bin, or /sbin is blocked. These are system directories; use a user-writable path.",
    },
    {
        id: "fork-bomb",
        test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c) || /\.\s*\|\s*\.\s*&/.test(c),
        message: "Fork bomb pattern detected and blocked.",
    },
    {
        id: "curl-pipe-shell",
        test: (c) => /\b(?:curl|wget|fetch)\b[^|;]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish|ksh|dash)\b/.test(c),
        message: "Piping remote content directly into a shell is blocked. Download the script, inspect it, then run it.",
    },
    {
        id: "pkill",
        test: (c) => /\bpkill\b/.test(c),
        message: "`pkill` is blocked — it can terminate unrelated processes by name. Kill a specific PID instead.",
    },
    {
        id: "kill-9",
        test: (c) => /\bkill\s+(?:-[a-zA-Z]*\s+)*-9\b|\bkill\s+-s\s+(?:9|SIGKILL)\b|\bkill\s+-SIGKILL\b/.test(c),
        message: "`kill -9` is blocked — it prevents cleanup. Try SIGTERM (default) first.",
    },
    {
        id: "npm-publish",
        test: (c) => /\bnpm\s+(?:publish|deprecate|unpublish)\b/.test(c),
        message: "`npm publish`/`deprecate`/`unpublish` is blocked. Publishing should be done deliberately, outside of an agent session.",
    },
    {
        id: "history-clear",
        test: (c) => /\bhistory\s+-c\b/.test(c),
        message: "`history -c` is blocked — erasing shell history hides what happened.",
    },
];
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
function deny(reason) {
    const output = {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
        },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(2);
}
async function main() {
    let payload;
    try {
        const raw = await readStdin();
        if (!raw.trim()) {
            process.exit(0);
        }
        payload = JSON.parse(raw);
    }
    catch {
        process.exit(0);
    }
    const command = payload?.tool_input?.command;
    if (typeof command !== "string" || command.length === 0) {
        process.exit(0);
    }
    for (const rule of rules) {
        if (rule.test(command)) {
            deny(`[${rule.id}] ${rule.message}`);
        }
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
export {};
