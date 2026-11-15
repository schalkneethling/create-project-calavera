// Issue #840: the repository README holds the one agent prompt that `--new` and `--init` print.
// The published package ships its own short README, not this one, so the CLI keeps the text in a
// constant and these tests compare what it prints with the README.
import { readFile } from "node:fs/promises";

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);
const AGENT_PROMPT_LINE = /^\d+\. Agent prompt: `([^`]+)`$/gm;

/** The agent prompt in the repository README's agent-first setup steps. */
export async function readmeAgentPrompt() {
  const readme = await readRepositoryFile("README.md");
  const prompts = [...readme.matchAll(AGENT_PROMPT_LINE)].map((match) => match[1]);
  if (prompts.length !== 1) {
    throw new Error(
      `Expected exactly one "Agent prompt:" step in README.md, found ${prompts.length}.`,
    );
  }
  return prompts[0];
}

/** The text after "Next prompt: " in the CLI's output. */
export function printedNextPrompt(stdout) {
  const prompts = [...stdout.matchAll(/^Next prompt: (.+)$/gm)].map((match) => match[1]);
  if (prompts.length !== 1) {
    throw new Error(
      `Expected exactly one "Next prompt:" line, found ${prompts.length}:\n${stdout}`,
    );
  }
  return prompts[0];
}

/** A file in the repository, by its path from the repository root. */
export async function readRepositoryFile(path) {
  return readFile(new URL(path, REPOSITORY_ROOT), "utf8");
}
