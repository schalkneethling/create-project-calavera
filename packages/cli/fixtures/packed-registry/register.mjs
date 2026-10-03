// Preload with `node --import` so a CLI subprocess resolves artifacts from the packed workspace
// tarballs in registry.mjs instead of the npm registry. Every other registry export is the real one.
import { registerHooks } from "node:module";

const REGISTRY_SPECIFIER = "@schalkneethling/calavera-artifact-core/registry";
const stubUrl = new URL("./registry.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === REGISTRY_SPECIFIER && context.parentURL !== stubUrl) {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
