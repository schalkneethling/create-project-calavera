const catalog = [
  entry("editorconfig", "Project consistency", "EditorConfig", "recommended"),
  entry("typescript", "Type checking", "TypeScript type checking", "recommended"),
  entry("oxlint", "Modern JS/TS linting", "Oxlint", "recommended", ["modern"]),
  entry("oxlint-eslint", "Modern JS/TS linting", "Oxc ESLint compatibility rules", "recommended", [
    "modern",
  ]),
  entry("oxlint-typescript", "Modern JS/TS linting", "Oxc TypeScript rules", "recommended", [
    "modern",
  ]),
  entry("oxlint-unicorn", "Modern JS/TS linting", "Oxc Unicorn rules", "recommended", ["modern"]),
  entry("oxlint-oxc", "Modern JS/TS linting", "Oxc native rules", "recommended", ["modern"]),
  entry("oxlint-import", "Imports and modules", "Oxc import rules", "optional", ["modern"]),
  entry("oxlint-react", "React correctness", "Oxc React rules", "framework-specific", ["modern"]),
  entry("oxlint-jsx-a11y", "Accessibility", "Oxc JSX accessibility rules", "optional", ["modern"]),
  entry("oxlint-node", "Node package rules", "Oxc Node rules", "optional", ["modern"]),
  entry("oxlint-promise", "Promise safety", "Oxc Promise rules", "optional", ["modern"]),
  entry("oxlint-vitest", "Test rules", "Oxc Vitest rules", "optional", ["modern"]),
  entry("oxlint-jest", "Test rules", "Oxc Jest rules", "optional", ["modern"]),
  entry("oxlint-nextjs", "Framework rules", "Oxc Next.js rules", "framework-specific", ["modern"]),
  entry("oxlint-vue", "Framework rules", "Oxc Vue rules", "framework-specific", ["modern"]),
  entry("oxlint-jsdoc", "Documentation rules", "Oxc JSDoc rules", "optional", ["modern"]),
  entry("oxfmt", "Formatting", "Oxfmt", "experimental", ["modern"]),
  entry("eslint", "Classic JS/TS linting", "ESLint flat config", "recommended", ["classic"]),
  entry("typescript-eslint", "Classic JS/TS linting", "TypeScript ESLint", "recommended", [
    "classic",
  ]),
  entry("eslint-config-prettier", "Formatting", "Prettier compatibility", "recommended", [
    "classic",
  ]),
  entry("eslint-react", "React correctness", "ESLint React rules", "framework-specific", [
    "classic",
  ]),
  entry("eslint-jsx-a11y", "Accessibility", "ESLint JSX accessibility rules", "optional", [
    "classic",
  ]),
  entry("eslint-import", "Imports and modules", "ESLint import rules", "optional", ["classic"]),
  entry("eslint-n", "Node package rules", "ESLint Node rules", "optional", ["classic"]),
  entry("eslint-promise", "Promise safety", "ESLint Promise rules", "optional", ["classic"]),
  entry("eslint-unicorn", "Classic JS/TS linting", "Unicorn rules", "optional", ["classic"]),
  entry("eslint-sonarjs", "Classic JS/TS linting", "SonarJS rules", "optional", ["classic"]),
  entry("eslint-vitest", "Test rules", "ESLint Vitest rules", "optional", ["classic"]),
  entry("eslint-jest", "Test rules", "ESLint Jest rules", "optional", ["classic"]),
  entry("stylelint", "CSS linting", "Stylelint", "recommended"),
  entry("stylelint-standard", "CSS linting", "Stylelint standard config", "recommended"),
  entry("stylelint-order", "CSS property ordering", "CSS property ordering", "optional"),
  entry("stylelint-baseline", "CSS Baseline", "CSS Baseline", "recommended"),
  entry("stylelint-scss", "CSS linting", "SCSS support", "framework-specific"),
  entry("stylelint-stylistic", "CSS linting", "Stylelint stylistic rules", "optional"),
  entry(
    "css-property-type-validator",
    "CSS property type validation",
    "CSS property type validation",
    "experimental",
  ),
  entry("prettier", "Formatting", "Prettier", "recommended", ["classic"]),
  entry("prettier-tailwind", "Formatting", "Tailwind class sorting", "optional", ["classic"]),
  entry("prettier-svelte", "Formatting", "Svelte formatting", "framework-specific", ["classic"]),
  entry("prettier-astro", "Formatting", "Astro formatting", "framework-specific", ["classic"]),
];

function entry(id, group, label, status, profiles = ["modern", "classic", "minimal"]) {
  return { id, group, label, status, profiles };
}

const defaults = {
  modern: [
    "editorconfig",
    "typescript",
    "oxlint",
    "oxlint-eslint",
    "oxlint-typescript",
    "oxlint-unicorn",
    "oxlint-oxc",
    "oxfmt",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  classic: [
    "editorconfig",
    "typescript",
    "eslint",
    "typescript-eslint",
    "eslint-config-prettier",
    "prettier",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  minimal: ["editorconfig"],
};

const form = document.querySelector("#composer");
const integrations = document.querySelector("#integrations");
const output = document.querySelector("#output");
function selectedProfile() {
  return new FormData(form).get("profile");
}

function visibleCatalog() {
  const profile = selectedProfile();
  return catalog.filter(({ profiles }) => profiles.includes(profile));
}

function renderIntegrations() {
  integrations.replaceChildren();

  const groups = visibleCatalog().reduce((grouped, item) => {
    grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
    return grouped;
  }, new Map());

  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "integration-group";
    section.innerHTML = `<h2>${group}</h2>`;

    for (const { id, label, status } of items) {
      const option = document.createElement("label");
      option.innerHTML = `
        <input type="checkbox" name="integration" value="${id}" />
        <span>${label}</span>
        <small>${status}</small>
      `;
      section.append(option);
    }

    integrations.append(section);
  }
}

function recipe() {
  const data = new FormData(form);
  return {
    $schema: "https://calavera.dev/schema/calavera.config.schema.json",
    version: 1,
    profile: data.get("profile"),
    packageManager: data.get("packageManager"),
    integrations: data.getAll("integration"),
    scripts: {
      lint: true,
      "lint:fix": true,
      format: true,
      "format:check": true,
      typecheck: true,
      check: true,
    },
  };
}

function render() {
  output.textContent = JSON.stringify(recipe(), null, 2);
}

function setDefaults() {
  const profile = selectedProfile();

  renderIntegrations();

  for (const checkbox of form.querySelectorAll('[name="integration"]')) {
    checkbox.checked = defaults[profile].includes(checkbox.value);
  }

  render();
}

async function saveFile() {
  const contents = JSON.stringify(recipe(), null, 2);

  if (!globalThis.showSaveFilePicker) {
    downloadFile();
    return;
  }

  const handle = await showSaveFilePicker({
    suggestedName: "calavera.config.json",
    types: [
      {
        description: "JSON",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const writable = await handle.createWritable();
  await writable.write(`${contents}\n`);
  await writable.close();
}

function downloadFile() {
  const blob = new Blob([`${JSON.stringify(recipe(), null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "calavera.config.json";
  link.click();
  URL.revokeObjectURL(url);
}

form.addEventListener("change", (event) => {
  if (event.target.name === "profile") {
    setDefaults();
  } else {
    render();
  }
});

document.querySelector("#save").addEventListener("click", () => {
  saveFile().catch((error) => {
    if (error.name !== "AbortError") {
      console.info(error);
    }
  });
});
document.querySelector("#download").addEventListener("click", downloadFile);

setDefaults();
