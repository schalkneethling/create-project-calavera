#!/usr/bin/env node
/**
 * dependency-map: a deterministic map of how a project uses its dependencies.
 *
 * For every declared package (or only the ones named with --packages) it reports:
 *   - where the package is declared (manifest, section, version range)
 *   - which files import it and which symbols they import
 *   - files that import it opaquely (default, namespace, or require), where member
 *     usage is NOT tracked and a targeted grep of those files is needed
 *   - config files and package.json scripts that appear to reference it
 *   - WORKAROUND(package) markers in code, stylesheets, HTML, shell scripts,
 *     YAML, TOML, Python, Ruby, Dockerfiles, and .npmrc
 *   - a usage fingerprint that changes when files or imported symbols change
 *
 * The script reads the current files on every run and writes nothing, so its output
 * cannot be stale. It has no dependencies and needs Node 18 or newer.
 *
 * Usage:
 *   node dependency-map.mjs [--root <dir>] [--packages a,b,c] [--json] [--max-files <n>]
 *
 * Known limits: parsing is regex-based, not a full AST. Imports are found in
 * JS/TS files, the script blocks of Vue/Svelte/Astro files, and @import/@use/
 * @forward/@plugin rules in stylesheets. Dynamic specifiers (import(variable)) and
 * usage that does not go through a module specifier are not tracked. Symlinks are
 * skipped, so the map never reads a file outside the project through a link.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const SFC_EXTENSIONS = new Set([".vue", ".svelte", ".astro"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".pcss"]);
// Markers are also read from files that use # comments, such as shell scripts,
// CI workflows, and .npmrc, because workarounds often live there.
const MARKER_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ...SFC_EXTENSIONS,
  ...STYLE_EXTENSIONS,
  ".html",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".rb",
]);
const MARKER_FILE_NAMES = new Set(["Dockerfile", ".npmrc"]);
// Dockerfile.dev and api.Dockerfile are common names for further Dockerfiles.
const DOCKERFILE_VARIANT = /^Dockerfile\.[^.]+$|^[^.]+\.Dockerfile$/;

function isMarkerFile(file) {
  const name = basename(file);
  return (
    MARKER_EXTENSIONS.has(extname(file)) ||
    MARKER_FILE_NAMES.has(name) ||
    DOCKERFILE_VARIANT.test(name)
  );
}
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vite",
  "out",
  "target",
  "vendor",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
// Imports that bind the whole module, so member usage is not visible in the import line.
const OPAQUE_SYMBOLS = new Set(["default", "*", "(require)", "(dynamic)"]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Removes // and block comments. String and template literal contents are copied
 * through untouched, so "https://x" survives. Newlines inside block comments are kept
 * so line counts do not change.
 */
export function stripComments(source) {
  let output = "";
  let index = 0;
  const length = source.length;

  while (index < length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index++;
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index++;
      }
      index += 2;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      output += character;
      index++;
      while (index < length && source[index] !== quote) {
        // A plain quote cannot span lines. Stopping here limits the damage of a stray
        // apostrophe in JSX text such as <p>Don't</p>.
        if (source[index] === "\n" && quote !== "`") break;
        if (source[index] === "\\") {
          output += source[index];
          index++;
        }
        if (index < length) {
          output += source[index];
          index++;
        }
      }
      if (index < length && source[index] === quote) {
        output += source[index];
        index++;
      }
      continue;
    }

    output += character;
    index++;
  }

  return output;
}

function parseImportClause(clause) {
  const symbols = [];
  const braces = clause.match(/\{([^}]*)\}/);
  const outside = clause.replace(/\{[^}]*\}/, "");

  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) symbols.push(name);
    }
  }

  if (/\*\s*as\s+[\w$]+/.test(outside) || outside.trim() === "*") {
    symbols.push("*");
  } else if (outside.replace(/,/g, " ").trim()) {
    symbols.push("default");
  }

  return symbols;
}

const CLAUSE = String.raw`([\w$\s{},*]+?)`;
const IMPORT_FROM = new RegExp(
  String.raw`(?:^|[^\w$.])import\s+(?:type\s+)?${CLAUSE}\s*from\s*(['"])([^'"\n]+)\2`,
  "g",
);
const EXPORT_FROM = new RegExp(
  String.raw`(?:^|[^\w$.])export\s+(?:type\s+)?${CLAUSE}\s*from\s*(['"])([^'"\n]+)\2`,
  "g",
);
const IMPORT_SIDE_EFFECT = /(?:^|[^\w$.])import\s*(['"])([^'"\n]+)\1/g;
const IMPORT_DYNAMIC = /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g;
const REQUIRE_CALL =
  /(?:(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*)?(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\3\s*\)/g;

/** Expects comment-stripped source. */
export function parseModuleReferences(source) {
  const references = [];

  for (const match of source.matchAll(IMPORT_FROM)) {
    references.push({ specifier: match[3], symbols: parseImportClause(match[1]) });
  }
  for (const match of source.matchAll(EXPORT_FROM)) {
    references.push({ specifier: match[3], symbols: parseImportClause(match[1]) });
  }
  for (const match of source.matchAll(IMPORT_SIDE_EFFECT)) {
    references.push({ specifier: match[2], symbols: [] });
  }
  for (const match of source.matchAll(IMPORT_DYNAMIC)) {
    references.push({ specifier: match[2], symbols: ["(dynamic)"] });
  }
  for (const match of source.matchAll(REQUIRE_CALL)) {
    const destructured = match[1];
    const symbols = destructured
      ? destructured
          .split(",")
          .map((part) => part.trim().split(":")[0].trim())
          .filter(Boolean)
      : ["(require)"];
    references.push({ specifier: match[4], symbols });
  }

  return references;
}

const STYLE_RULE = /@(?:import|use|forward|plugin)\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/g;

export function parseStyleReferences(source) {
  return [...stripComments(source).matchAll(STYLE_RULE)].map((match) => ({
    specifier: match[2].replace(/^~/, ""),
    symbols: [],
  }));
}

/**
 * Maps a module specifier to a package name, or null when it cannot be a package
 * (relative paths, absolute paths, node: URLs, #imports, ~/ and @/ aliases, URLs).
 * Builtins such as "fs" are returned as names; they are filtered out later because
 * only declared packages are reported.
 */
export function toPackageName(specifier) {
  if (/^[./#~]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;

  const parts = specifier.split("/");
  let name;
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || parts[0].length < 2 || !parts[1]) return null;
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = parts[0];
  }

  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name : null;
}

export function extractScriptBlocks(source, extension) {
  if (!SFC_EXTENSIONS.has(extension)) return [source];

  // HTML ends a script element at </script followed by a tab, line feed, form
  // feed, space, / or >, and ignores the rest of that tag. A carriage return
  // counts too, because HTML turns it into a line feed before reading tags.
  const blocks = [
    ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi),
  ].map((match) => match[1]);
  if (extension === ".astro") {
    const frontmatter = source.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter) blocks.unshift(frontmatter[1]);
  }
  return blocks;
}

/** Parses WORKAROUND(package): description | upstream: URL | remove-when: range */
export function parseMarkers(text) {
  const markers = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    const match = /WORKAROUND\(([^)\s]+)\)\s*:?\s*(.*)$/.exec(lineText);
    if (!match) return;

    const rest = match[2].replace(/\s*(\*\/|--!?>)\s*$/, "").trim();
    const [description, ...fields] = rest.split(/\s+\|\s+/);
    let upstream = null;
    let removeWhen = null;

    for (const field of fields) {
      const upstreamMatch = /^upstream:\s*(.+)$/i.exec(field.trim());
      const removeMatch = /^remove-when:\s*(.+)$/i.exec(field.trim());
      if (upstreamMatch) upstream = upstreamMatch[1].trim();
      if (removeMatch) removeWhen = removeMatch[1].trim();
    }

    markers.push({
      package: match[1],
      description: description.trim(),
      upstream,
      removeWhen,
      line: index + 1,
    });
  });

  return markers;
}

/**
 * A short hash of which files use a package and which symbols they import. Line
 * numbers and file contents are deliberately excluded so that ordinary edits do not
 * change it. Adding or removing a file or an imported symbol does.
 */
export function computeFingerprint(entries) {
  if (entries.length === 0) return "none";

  const lines = entries.flatMap(({ file, symbols }) =>
    symbols.length > 0 ? symbols.map((symbol) => `${file}\0${symbol}`) : [`${file}\0`],
  );
  const unique = [...new Set(lines)].sort();
  return createHash("sha256").update(unique.join("\n")).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walk(root, directory = root, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(root, full, found);
    } else if (entry.isFile()) {
      found.push(
        full
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
      );
    }
  }
  return found;
}

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function listFiles(root) {
  if (existsSync(join(root, ".git"))) {
    try {
      const output = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const files = output
        .split("\0")
        .filter(Boolean)
        .filter((file) => !file.split("/").includes("node_modules"))
        // Like the directory walk, skip symlinks, so a link cannot make the map
        // read a file outside the project. A link to a file inside the project
        // loses nothing, because that file is listed itself.
        .filter((file) => isRegularFile(join(root, file)));
      return { files, mode: "git" };
    } catch {
      // Fall through to the directory walk.
    }
  }
  return { files: walk(root), mode: "walk" };
}

function readText(root, file) {
  try {
    const full = join(root, file);
    if (statSync(full).size > MAX_FILE_BYTES) return null;
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map building
// ---------------------------------------------------------------------------

function readManifests(root, files) {
  const manifests = [];
  for (const file of files.filter((candidate) => basename(candidate) === "package.json")) {
    const text = readText(root, file);
    if (text === null) continue;
    try {
      manifests.push({ file, json: JSON.parse(text) });
    } catch {
      // A malformed manifest should not stop the scan.
    }
  }
  return manifests;
}

function binNames(root, packageName) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "node_modules", packageName, "package.json"), "utf8"),
    );
    if (typeof manifest.bin === "string") return [packageName.replace(/^@[^/]+\//, "")];
    if (manifest.bin && typeof manifest.bin === "object") return Object.keys(manifest.bin);
  } catch {
    // Not installed, which is fine.
  }
  return [];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMap({ root, packages } = {}) {
  const absoluteRoot = resolve(root ?? process.cwd());
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Root directory does not exist: ${absoluteRoot}`);
  }
  const { files, mode } = listFiles(absoluteRoot);
  const manifests = readManifests(absoluteRoot, files);

  const internalNames = new Set(manifests.map((manifest) => manifest.json.name).filter(Boolean));
  const declared = new Map();
  for (const { file, json } of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, range] of Object.entries(json[section] ?? {})) {
        if (internalNames.has(name)) continue;
        if (!declared.has(name)) declared.set(name, []);
        declared.get(name).push({ manifest: file, section, range });
      }
    }
  }

  const requested = packages && packages.length > 0 ? new Set(packages) : null;
  const relevant = requested ?? new Set(declared.keys());

  const usage = new Map();
  const allMarkers = [];

  for (const file of files) {
    const extension = extname(file);
    const isCode = CODE_EXTENSIONS.has(extension) || SFC_EXTENSIONS.has(extension);
    const isStyle = STYLE_EXTENSIONS.has(extension);
    if (!isMarkerFile(file)) continue;

    const text = readText(absoluteRoot, file);
    if (text === null) continue;

    for (const marker of parseMarkers(text)) allMarkers.push({ ...marker, file });

    let references = [];
    if (isCode) {
      for (const block of extractScriptBlocks(text, extension)) {
        references.push(...parseModuleReferences(stripComments(block)));
      }
    } else if (isStyle) {
      references = parseStyleReferences(text);
    }

    for (const { specifier, symbols } of references) {
      const name = toPackageName(specifier);
      if (!name || !relevant.has(name)) continue;

      if (!usage.has(name)) usage.set(name, { files: new Map(), subpaths: new Set() });
      const entry = usage.get(name);
      if (!entry.files.has(file)) entry.files.set(file, new Set());
      for (const symbol of symbols) entry.files.get(file).add(symbol);
      if (specifier !== name) entry.subpaths.add(specifier);
    }
  }

  const names = [...(requested ?? new Set(declared.keys()))].sort();
  const result = names.map((name) => {
    const entry = usage.get(name);
    const fileEntries = entry
      ? [...entry.files.entries()].map(([file, symbols]) => ({
          file,
          symbols: [...symbols].sort(),
        }))
      : [];

    const symbolCounts = {};
    for (const { symbols } of fileEntries) {
      for (const symbol of symbols) {
        if (!OPAQUE_SYMBOLS.has(symbol)) symbolCounts[symbol] = (symbolCounts[symbol] ?? 0) + 1;
      }
    }

    const baseName = name.replace(/^@[^/]+\//, "");
    const configPattern = new RegExp(
      `^(?:${escapeRegExp(baseName)}\\.config\\.[cm]?[jt]s|\\.${escapeRegExp(baseName)}rc(?:\\..+)?)$`,
    );
    const configFiles = files.filter((file) => configPattern.test(basename(file))).sort();

    // @types packages are never run, and their base name ("node") collides with real commands.
    const commandNames = name.startsWith("@types/")
      ? []
      : [...new Set([baseName, ...binNames(absoluteRoot, name)])];
    const scripts = [];
    for (const { json } of manifests) {
      for (const [scriptName, command] of Object.entries(json.scripts ?? {})) {
        const tokens = String(command).split(/[\s;&|()]+/);
        if (
          commandNames.some((command_) => tokens.includes(command_)) &&
          !scripts.includes(scriptName)
        ) {
          scripts.push(scriptName);
        }
      }
    }

    return {
      name,
      declared: declared.get(name) ?? [],
      files: fileEntries.map(({ file }) => file).sort(),
      symbols: symbolCounts,
      opaqueFiles: fileEntries
        .filter(({ symbols }) => symbols.some((symbol) => OPAQUE_SYMBOLS.has(symbol)))
        .map(({ file }) => file)
        .sort(),
      subpaths: entry ? [...entry.subpaths].sort() : [],
      configFiles,
      scripts,
      fingerprint: computeFingerprint(fileEntries),
      markers: allMarkers
        .filter((marker) => marker.package === name)
        .map(({ package: markerPackage, file, line, description, upstream, removeWhen }) => ({
          package: markerPackage,
          file,
          line,
          description,
          upstream,
          removeWhen,
        })),
    };
  });

  const reported = new Set(names);
  const otherMarkers = requested
    ? []
    : allMarkers
        .filter((marker) => !reported.has(marker.package))
        .map(({ package: markerPackage, file, line, description, upstream, removeWhen }) => ({
          package: markerPackage,
          file,
          line,
          description,
          upstream,
          removeWhen,
        }));

  return { root: absoluteRoot, mode, filesScanned: files.length, packages: result, otherMarkers };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function formatMarker(marker) {
  const fields = [marker.description];
  if (marker.upstream) fields.push(`upstream: ${marker.upstream}`);
  if (marker.removeWhen) fields.push(`remove-when: ${marker.removeWhen}`);
  return `${marker.file}:${marker.line}  WORKAROUND(${marker.package}): ${fields.join(" | ")}`;
}

function formatDeclared(declared) {
  if (declared.length === 0)
    return "not a direct dependency (transitive, or not declared in a scanned manifest)";

  const groups = new Map();
  for (const { manifest, section, range } of declared) {
    const key = `${section} ${range}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(manifest);
  }

  return [...groups.entries()]
    .map(([key, manifests]) => {
      if (manifests.length === 1)
        return manifests[0] === "package.json" ? key : `${key} in ${manifests[0]}`;
      return `${key} (${manifests.length} manifests)`;
    })
    .join("; ");
}

export function formatText(map, { maxFiles = 12 } = {}) {
  const lines = [`dependency-map  root=${map.root}  scan=${map.mode}  files=${map.filesScanned}`];

  for (const pkg of map.packages) {
    lines.push("");
    lines.push(`${pkg.name}  [${formatDeclared(pkg.declared)}]  fingerprint=${pkg.fingerprint}`);

    if (pkg.files.length === 0) {
      lines.push("  imported in: 0 files");
    } else {
      const shown = pkg.files.slice(0, maxFiles).join(", ");
      const more = pkg.files.length > maxFiles ? ` (+${pkg.files.length - maxFiles} more)` : "";
      lines.push(
        `  imported in ${pkg.files.length} file${pkg.files.length === 1 ? "" : "s"}: ${shown}${more}`,
      );
    }

    const symbolEntries = Object.entries(pkg.symbols).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    if (symbolEntries.length > 0) {
      lines.push(
        `  named symbols: ${symbolEntries.map(([symbol, count]) => `${symbol} (${count} file${count === 1 ? "" : "s"})`).join(", ")}`,
      );
    }
    if (pkg.opaqueFiles.length > 0 && pkg.opaqueFiles.length === pkg.files.length) {
      lines.push(
        "  all imports are opaque (default, namespace, require, or dynamic): member usage is not tracked, grep the files above",
      );
    } else if (pkg.opaqueFiles.length > 0) {
      const shown = pkg.opaqueFiles.slice(0, maxFiles).join(", ");
      const more =
        pkg.opaqueFiles.length > maxFiles ? ` (+${pkg.opaqueFiles.length - maxFiles} more)` : "";
      lines.push(
        `  opaque imports (default, namespace, or require; member usage not tracked, grep these files): ${shown}${more}`,
      );
    }
    if (pkg.subpaths.length > 0) lines.push(`  subpaths: ${pkg.subpaths.join(", ")}`);
    if (pkg.configFiles.length > 0) lines.push(`  config files: ${pkg.configFiles.join(", ")}`);
    if (pkg.scripts.length > 0) lines.push(`  package.json scripts: ${pkg.scripts.join(", ")}`);
    if (pkg.markers.length > 0) {
      lines.push("  workaround markers:");
      for (const marker of pkg.markers) lines.push(`    ${formatMarker(marker)}`);
    }
  }

  if (map.otherMarkers.length > 0) {
    lines.push("", "other workaround markers (name is not a declared package):");
    for (const marker of map.otherMarkers) lines.push(`  ${formatMarker(marker)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: node dependency-map.mjs [--root <dir>] [--packages a,b,c] [--json] [--max-files <n>]

  --root <dir>        Project directory to scan (default: current directory)
  --packages <list>   Comma-separated package names to report (default: all declared)
  --json              Print full JSON with no truncation
  --max-files <n>     File names to list per package in text output (default: 12)
`;

function parseArguments(argv) {
  const options = { root: process.cwd(), packages: null, json: false, maxFiles: 12, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--packages")
      options.packages = (argv[++index] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    else if (argument === "--json") options.json = true;
    else if (argument === "--max-files") options.maxFiles = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1)
    throw new Error("--max-files must be a positive integer");
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  let map;
  try {
    map = buildMap({ root: options.root, packages: options.packages });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const output = options.json
    ? JSON.stringify(map, null, 2)
    : formatText(map, { maxFiles: options.maxFiles });
  process.stdout.write(`${output}\n`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
