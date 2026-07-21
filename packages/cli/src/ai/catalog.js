import { artifactCatalog, DEFAULT_ARTIFACT_TARGET } from "@schalkneethling/calavera-artifact-core";

export const DEFAULT_AI_TARGET = DEFAULT_ARTIFACT_TARGET;

export const aiArtifactCatalog = artifactCatalog.map((artifact) => ({
  id: artifact.id,
  type: artifact.type,
  src: artifact.legacyPath,
  packageName: artifact.packageName,
  version: artifact.version,
  compatibility: artifact.compatibility,
  payload: artifact.payload,
  targets: artifact.targets,
  label: artifact.displayName,
  group: artifact.group,
  status: "packaged",
  defaultTarget: artifact.defaultTarget,
}));
