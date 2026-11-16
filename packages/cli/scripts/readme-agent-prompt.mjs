// Issue #840: the repository README holds the one agent prompt that `--new` and `--init` print.
// The published package ships its own short README, not this one, so the CLI keeps the text in a
// constant and these tests compare what it prints with the README. The README must keep the prompt
// on one numbered line, "N. Agent prompt: " followed by the prompt in backticks, with no backtick inside the prompt; a change of
// that format makes readmeAgentPrompt throw rather than pass.
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

export const NEXT_PROMPT_HEADING = "Next prompt. Copy all of it into your agent as one message:";

/**
 * The prompt block in the CLI's output (#601): the heading, a blank line, the prompt alone on one
 * line, and a blank line.
 */
export function printedNextPrompt(stdout) {
  const lines = stdout.split("\n");
  const headings = lines.flatMap((line, index) => (line === NEXT_PROMPT_HEADING ? [index] : []));
  if (headings.length !== 1) {
    throw new Error(
      `Expected exactly one "${NEXT_PROMPT_HEADING}" line, found ${headings.length}:\n${stdout}`,
    );
  }
  const [blankBefore, prompt, blankAfter] = lines.slice(headings[0] + 1, headings[0] + 4);
  if (blankBefore !== "" || !prompt || blankAfter !== "") {
    throw new Error(`Expected the prompt alone between two blank lines:\n${stdout}`);
  }
  return prompt;
}

/** A file in the repository, by its path from the repository root. */
export async function readRepositoryFile(path) {
  return readFile(new URL(path, REPOSITORY_ROOT), "utf8");
}
