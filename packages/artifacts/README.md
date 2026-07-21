# Artifact packages

Each child workspace is one independently versioned Calavera skill, hook, or agent. Its payload and `calavera-artifact.json` manifest are the source of truth; the CLI consumes them through `@schalkneethling/calavera-artifact-core` rather than keeping a second bundled copy.

The current catalog contains 12 skills, two hooks, and one agent. The roadmap's earlier count of 13 skills predates the issue #160 frontend consolidation.
