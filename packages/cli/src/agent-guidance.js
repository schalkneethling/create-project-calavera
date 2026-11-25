// @ts-check
// The templates for the agent guidance and the MCP setup notes that the bootstrap (`--init`)
// writes, and the agent prompt it prints. They live apart from the apply and composition logic in
// index.js (#247, #1134). A change to the text of a written file must also be registered in
// src/utils/earlier-guidance.js under the release that writes it (#830).
import packageJson from "../package.json" with { type: "json" };
import {
  AGENT_BOOTSTRAP_MARKER,
  AGENT_BOOTSTRAP_MCP_FILE,
  AGENT_BOOTSTRAP_SECTION_END,
  AGENT_BOOTSTRAP_SECTION_START,
} from "./agent-bootstrap-files.js";
import { projectLocalCommandCatalog } from "./project-local-commands.js";
import {
  createCodexMcpTomlBlock,
  createCursorMcpJsonConfig,
  createMcpServersJsonConfig,
  createOpenCodeMcpJsonConfig,
} from "./utils/mcp-config.js";
import { formatShellCommand } from "./utils/shell.js";

/**
 * @typedef {import("./index.js").PackageManager} PackageManager
 * @typedef {object} McpLaunchCommands The package managers the MCP setup notes list, in order, and
 *   the MCP launch command for each. index.js supplies them, because it owns both.
 * @property {PackageManager[]} packageManagers
 * @property {(packageManager: PackageManager) => { command: string, args: string[] }} launchCommandFor
 */

// The agent prompt `--new` and `--init` print. The repository README's "Agent prompt" step is the
// source of this text (#840); the published package ships a short README without it, so the text
// lives here, and tests that read the README through scripts/readme-agent-prompt.mjs fail when
// the two differ.
export const AGENT_BOOTSTRAP_NEXT_PROMPT =
  "Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, validate and explain it, show me the dry-run result, and apply it only after I approve.";
// The suggested first prompt in `.agents/calavera/mcp.md`, which still predates the README text.
// Changing it changes the file's text, which must then be registered in
// src/utils/earlier-guidance.js under the release that writes it (#830). That release is not known
// until its version pull request, so the follow-up named in the #840 pull request moves this text
// onto AGENT_BOOTSTRAP_NEXT_PROMPT then, together with both copies of the Calavera skill.
const AGENT_BOOTSTRAP_MCP_NOTES_PROMPT =
  "Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, show me the dry-run result, and apply it only after I approve.";

function createAgentBootstrapGuidanceBody() {
  return `# Calavera Agent Guidance

- Use Calavera when the user wants to inspect, compose, preview, apply, or update project tooling.
- Verify the Calavera MCP tools are available before composing a recipe.
- Prefer the Calavera MCP server over hand-authoring \`calavera.config.json\`.
- If the Calavera MCP tools are not available, stop and help the user register the MCP server from \`${AGENT_BOOTSTRAP_MCP_FILE}\`, then reload the agent session if the MCP host requires it.
- Do not inspect npm cache internals or import Calavera source files from a package cache as a substitute for MCP setup.
- Inspect existing project tooling before composing a recipe and raise likely config conflicts early.
- If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use \`dry_run_apply\` to show concrete impact when adoption still looks possible.
- Start with \`inspect_project\`, \`list_profiles\`, \`list_integrations\`, and \`list_ai_artifacts\`; use \`describe_integration\` when the user asks for more information or an option needs explanation.
- Compose recipes with \`compose_recipe\`, validate them with \`validate_recipe\`, and explain the selected integrations with \`explain_recipe\`.
- Always present \`dry_run_apply\` output to the user before changing files.
- Call \`apply_recipe\` only after the user explicitly approves the dry-run result.
- If the MCP transport closes or reports \`-32000\` during or immediately after \`apply_recipe\`, treat the outcome as unknown instead of failed. Inspect \`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package metadata before retrying the apply.
- Treat files listed by \`dry_run_apply\` as Calavera-managed outputs. Do not hand-write or edit them; let \`apply_recipe\` or \`create-project-calavera apply\` create them after approval.
- Use AskUserTool or the agent client's equivalent when available for profile choices, conflict decisions, and apply approval.

MCP setup notes live in \`${AGENT_BOOTSTRAP_MCP_FILE}\`.
`;
}

// A blank line separates each marker from the guidance, because Markdown formatters such as Oxfmt
// add one between an HTML comment and the heading that follows it (#669).
export function createAgentBootstrapGuidance() {
  return `${AGENT_BOOTSTRAP_MARKER}

${createAgentBootstrapGuidanceBody()}`;
}

export function createAgentBootstrapGuidanceSection() {
  return `${AGENT_BOOTSTRAP_SECTION_START}

${createAgentBootstrapGuidanceBody().trimEnd()}

${AGENT_BOOTSTRAP_SECTION_END}
`;
}

/**
 * @param {McpLaunchCommands} launchCommands
 * @returns {string}
 */
function createMcpManualCommandReference({ packageManagers, launchCommandFor }) {
  return packageManagers
    .map((packageManager) => {
      const commands = projectLocalCommandCatalog[packageManager];
      return `- ${commands.label}: \`${formatShellCommand(launchCommandFor(packageManager))}\``;
    })
    .join("\n");
}

/**
 * The text of `.agents/calavera/mcp.md` for the project's package manager.
 *
 * @param {PackageManager} packageManager
 * @param {McpLaunchCommands} launchCommands
 * @returns {string}
 */
export function createAgentBootstrapMcpInstructions(packageManager, launchCommands) {
  const commands = projectLocalCommandCatalog[packageManager];
  const launchCommand = launchCommands.launchCommandFor(packageManager);
  const mcpConfig = JSON.stringify(createMcpServersJsonConfig(launchCommand), null, 2);
  const cursorConfig = JSON.stringify(createCursorMcpJsonConfig(launchCommand), null, 2);
  const codexConfig = createCodexMcpTomlBlock(launchCommand).trimEnd();
  const opencodeConfig = JSON.stringify(createOpenCodeMcpJsonConfig(launchCommand), null, 2);
  const shellCommand = formatShellCommand(launchCommand);
  const manualCommandReference = createMcpManualCommandReference(launchCommands);

  return `# Calavera MCP Setup

Calavera can configure MCP automatically during \`--init\` for one project-local
agent harness. It never writes global/user MCP config. If you skipped
auto-config or need to repair a setup manually, use the project-local target for
your harness.

This project's detected package manager is ${commands.label}; the launch command
is:

\`\`\`bash
${shellCommand}
\`\`\`

## Project-local targets

### Claude Code: \`.mcp.json\`

\`\`\`json
${mcpConfig}
\`\`\`

### Cursor: \`.cursor/mcp.json\`

\`\`\`json
${cursorConfig}
\`\`\`

### Codex: \`.codex/config.toml\`

\`\`\`toml
${codexConfig}
\`\`\`

### OpenCode: \`opencode.json\`

\`\`\`json
${opencodeConfig}
\`\`\`

Calavera requires OpenCode 2. OpenCode's migration guide says not to point
OpenCode 1.x at files in the \`mcp.servers\` layout.

Project-local MCP servers should be registered from the project root. Using the
package manager declared by the project avoids package-manager preflight
failures before Calavera can start, such as npm rejecting a Bun-managed project
through \`devEngines.packageManager\`.

When configuring an MCP server manually, choose the command that matches the
project's package manager:

${manualCommandReference}

After registration, reload or restart the agent session if your MCP host does not
discover new tools dynamically. Confirm the Calavera tools are visible before
composing a recipe.

Do not work around missing MCP tools by reading npm cache internals or importing
Calavera source files from package cache paths. That bypasses the supported MCP
setup and can use the wrong cached package version.

## Command syntax for agents

\`npm create\` uses \`--\` to forward flags to Calavera:

\`\`\`bash
npm create project-calavera -- --init
npm create project-calavera apply -- --dry-run
\`\`\`

Do not use \`npm create project-calavera --init\`; npm treats \`--init\` as its own
option and Calavera falls back to the recipe CLI.

Direct binary launchers such as \`npx --package\` and MCP server registrations
do not need an extra \`--\` before Calavera flags:

\`\`\`bash
npx --package create-project-calavera@${packageJson.version} create-project-calavera --help
${shellCommand}
\`\`\`

## Bun temp and cache directories

If a Bun-based MCP launch fails before Calavera starts with
\`error: bun is unable to write files to tempdir: PermissionDenied\`, configure
the MCP host to give that server a writable temp directory. Set \`TMPDIR\` to an
absolute path that exists and is writable by the MCP host process, such as an
absolute path to a project-local \`.calavera/tmp\` directory.

If Bun can write temp files but cannot populate its package cache, also set
\`BUN_INSTALL_CACHE_DIR\` to an absolute writable directory, such as an absolute
path to \`.calavera/bun-install-cache\`. Keep these environment overrides on Bun
MCP registrations only; they are recovery settings for restricted hosts, not
part of the default Calavera MCP config.

## Calavera MCP workflow

Use the tools in this order when they are available:

1. \`inspect_project\`
2. \`list_profiles\`
3. \`list_integrations\`
4. \`describe_integration\`
5. \`list_ai_artifacts\`
6. \`compose_recipe\`
7. \`validate_recipe\`
8. \`explain_recipe\`
9. \`dry_run_apply\`
10. \`apply_recipe\`

\`dry_run_apply\` is the review boundary. Show its inspection findings, omitted
script explanations, ownership notes, and planned file changes to the user,
including the command each \`package.json\` script in \`scriptChanges\` will run
and, for a changed or renamed script, the command it replaces, then wait for
explicit approval before calling \`apply_recipe\`.

\`apply_recipe.writeConfig: false\` only skips writing \`calavera.config.json\`.
Do not use it to bypass managed-file conflicts, stale state hashes, or an
unapproved dry-run result.

If the MCP transport closes or reports \`-32000\` during or immediately after
\`apply_recipe\`, treat the apply outcome as unknown instead of failed. Inspect
\`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package
metadata before retrying the apply.

Before composing a recipe, call \`inspect_project\` or inspect the project for existing tooling files such as \`package.json\`, \`calavera.config.json\`, \`.editorconfig\`, and \`.stylelintrc.json\`. Mention likely conflicts or local conventions before proposing changes. If conflicts exist, say whether they are hard stops or migration decisions, then use \`dry_run_apply\` to show the impact when adoption is still possible.

If the MCP server cannot be registered, use the hosted Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

Then run \`${commands.applyDryRun}\` and ask for approval before running \`${commands.applyRecipe}\`.

Suggested first prompt:

> ${AGENT_BOOTSTRAP_MCP_NOTES_PROMPT}
`;
}
