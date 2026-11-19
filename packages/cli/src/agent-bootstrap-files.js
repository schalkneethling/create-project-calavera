// @ts-check

// The files the bootstrap (`--init`) writes its agent guidance and MCP setup notes to, and the
// markers it puts in the guidance. The bootstrap writes them and `eject` removes them (ADR-0017,
// Decision 2), so both read them from here.

export const AGENT_BOOTSTRAP_GUIDANCE_FILE = "AGENTS.md";
export const AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE = "AGENTS.calavera.md";
export const AGENT_BOOTSTRAP_MCP_FILE = ".agents/calavera/mcp.md";
/** The first line of the guidance written as a whole file, and of `AGENTS.calavera.md`. */
export const AGENT_BOOTSTRAP_MARKER = "<!-- calavera-agent-bootstrap -->";
/** The markers around the guidance section appended to an existing `AGENTS.md`. */
export const AGENT_BOOTSTRAP_SECTION_START = "<!-- calavera-agent-bootstrap:start -->";
export const AGENT_BOOTSTRAP_SECTION_END = "<!-- calavera-agent-bootstrap:end -->";
