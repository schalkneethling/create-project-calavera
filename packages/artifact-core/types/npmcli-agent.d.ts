// @npmcli/agent ships no type declarations. This declares only the export artifact-core uses, as
// lib/index.js of @npmcli/agent 5.0.2 defines it: the cached agent for a URL and its options.
declare module "@npmcli/agent" {
  export function getAgent(
    url: string | URL,
    options?: Record<string, unknown>,
  ): import("node:http").Agent;
}
