---
"@schalkneethling/calavera-skill-calavera": patch
"create-project-calavera": patch
---

Every description of `--reown-managed-file` now says that `apply` replaces the edited file's current contents with Calavera's, so the edits are lost unless you save a copy first. Before, the dry run's warning said the run would "treat the current contents as an approved managed-file baseline", which read as keeping the edit. The change covers the dry run's `managed-file-reown` warning, the `--help` text, the MCP `reownManagedFiles` input description, and both copies of the Calavera skill, which now also tell the agent never to use `reownManagedFiles` to keep an edit. What the flag does is unchanged (#1167).
