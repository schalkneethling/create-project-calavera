# Dependabot Package Ecosystem Identifiers

Reference: https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file#package-ecosystem

| Identifier       | Ecosystem                  | Manifest file(s)                     |
| ---------------- | -------------------------- | ------------------------------------ |
| `npm`            | npm / Yarn / pnpm          | `package.json`                       |
| `pip`            | pip / Poetry / pip-compile | `requirements.txt`, `pyproject.toml` |
| `cargo`          | Rust / Cargo               | `Cargo.toml`                         |
| `bundler`        | Ruby / Bundler             | `Gemfile`                            |
| `composer`       | PHP / Composer             | `composer.json`                      |
| `docker`         | Docker                     | `Dockerfile`                         |
| `gradle`         | Java / Gradle              | `build.gradle`, `build.gradle.kts`   |
| `maven`          | Java / Maven               | `pom.xml`                            |
| `gomod`          | Go modules                 | `go.mod`                             |
| `nuget`          | .NET / NuGet               | `*.csproj`, `packages.config`        |
| `github-actions` | GitHub Actions workflows   | `.github/workflows/*.yml`            |
| `terraform`      | Terraform                  | `*.tf`                               |
| `elm`            | Elm                        | `elm.json`                           |
| `pub`            | Dart / Flutter             | `pubspec.yaml`                       |
| `swift`          | Swift Package Manager      | `Package.swift`                      |
| `bazel`          | Bazel                      | `MODULE.bazel`, `WORKSPACE`          |
| `bun`            | Bun                        | `bun.lock`                           |
| `conda`          | Conda                      | `environment.yml`                    |
| `deno`           | Deno                       | `deno.json`, `deno.lock`             |
| `devcontainers`  | Dev containers             | `.devcontainer.json`                 |
| `docker-compose` | Docker Compose             | `compose.yml`, `docker-compose.yml`  |
| `dotnet-sdk`     | .NET SDK                   | `global.json`                        |
| `gitsubmodule`   | Git submodules             | `.gitmodules`                        |
| `helm`           | Helm                       | `Chart.yaml`                         |
| `julia`          | Julia                      | `Project.toml`                       |
| `mix`            | Elixir / Hex               | `mix.exs`                            |
| `nix`            | Nix flakes                 | `flake.nix`                          |
| `opentofu`       | OpenTofu                   | `*.tofu`, `.terraform.lock.hcl`      |
| `pre-commit`     | pre-commit                 | `.pre-commit-config.yaml`            |
| `rust-toolchain` | Rust toolchain             | `rust-toolchain.toml`                |
| `sbt`            | Scala / sbt                | `build.sbt`                          |
| `uv`             | uv                         | `pyproject.toml`, `uv.lock`          |
| `vcpkg`          | vcpkg                      | `vcpkg.json`                         |

## Directory conventions

- Single-package project: `directory: "/"`
- Monorepo with packages in subdirectories: one block per directory, e.g.
  `directory: "/packages/ui"`, `directory: "/packages/api"`
- Use `directories` for multiple locations; it supports `*` and recursive `**/*` glob patterns.
- Docker images referenced in a subdirectory: `directory: "/docker"`

## Notes

- `github-actions` must use `directory: "/"`; Dependabot then scans `.github/workflows/` and root `action.yml`/`action.yaml` files.
- Multiple ecosystems in the same directory each require their own `updates` block.
