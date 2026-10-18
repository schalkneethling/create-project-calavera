# Plugins

Each folder here is one plugin in the `calavera` Claude Code marketplace, which `.claude-plugin/marketplace.json` at the repository root describes. A plugin folder serves two formats at once: [Agent Plugins 1.0.0](https://agent-plugins.org/specification) reads `plugin.json`, `skills/`, and `mcp.json`, and Claude Code reads the plugin's entry in the marketplace. See issue #704 for the reasons behind these rules.

## Add a plugin

1. Create `plugins/<name>/plugin.json` in the Agent Plugins format, with `$schema` set to `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and `name` set to the folder name. The name is permanent, because it is part of every install ID, such as `<name>@calavera`.
2. Put each skill in `skills/<skill>/SKILL.md`, with `name` set to the folder name, and add this to its frontmatter:

   ```yaml
   metadata:
     internal: true
   ```

   Without it, `npx skills add schalkneethling/create-project-calavera` lists the plugin skills in place of the bundled skills.

3. Add an entry to `.claude-plugin/marketplace.json` with the same `name` and `"source": "./plugins/<name>"`. Put everything Claude Code needs that the Agent Plugins files do not cover in the entry, such as `"mcpServers": "./mcp.json"`. Claude Code-only folders such as `agents/` and `commands/` can sit in the plugin folder.
4. Run `pnpm test:plugins`, `pnpm plugins:validate`, and `pnpm skills:discovery:check`.

## Rules the checks enforce

- No `version` in `plugin.json` or the marketplace entry, so Claude Code uses the latest commit of this repository as the version. Any commit to the repository counts as an update to every plugin, which #705 revisits.
- No `.claude-plugin/plugin.json` inside a plugin. A Claude manifest without a version fails `claude plugin validate --strict`, so the marketplace entry is the only Claude manifest.
- No `hooks/` folder. Declare hooks inline in the marketplace entry, the only form Claude Code loads from an entry.
- MCP servers are declared only in `mcp.json`, never inline in the marketplace entry or in a Claude Code `.mcp.json`, and the entry sets `"mcpServers": "./mcp.json"`.
- Each `SKILL.md` is directly in `skills/<skill>/`, with `metadata.internal` set to `true`.
- MCP servers in `mcp.json` use the `stdio` transport and do not name `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`, or the matching data variables. The two formats spell those differently, so a server that needs them cannot share one file yet.
