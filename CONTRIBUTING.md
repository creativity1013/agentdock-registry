# Contributing to AgentDock

Thanks for your interest in contributing! AgentDock is a self-hosted AI capability marketplace for skill / agent / plugin packages, built as a **zero-third-party-dependency** Node.js project. This guide covers everything you need to get started.

## Development Environment

- **Node.js >= 20.11** (24 LTS recommended; the optional SQLite backend requires Node 24+ for `node:sqlite`)
- No `npm install` needed — the project has zero third-party dependencies and no lockfile

<!-- TODO: 替换为真实仓库地址 -->

```bash
git clone https://github.com/<owner>/agentdock.git
cd agentdock
npm start          # starts the server on http://127.0.0.1:7788
```

## Running Tests

```bash
npm test           # unit + HTTP API tests via node --test (177 test cases)
npm run smoke      # end-to-end smoke test: real server + CLI + on-disk installs (json backend)
npm run smoke:sqlite   # same smoke test against the sqlite backend (Node 24+)
npm run test:sqlite    # sqlite backend tests (auto-skip on Node 20/22)
```

Both `npm test` and `npm run smoke` run offline in an isolated temp directory and never touch your local `data/`.

## Code Style

The single most important constraint: **zero third-party dependencies**.

- Only use `node:` built-in modules (`node:http`, `node:crypto`, `node:fs`, `node:test`, ...) and global `fetch`.
- Tests use the built-in `node:test` runner — no Jest, no Mocha, no test libraries.
- No build step for the web UI (vanilla JS in `web/`); no transpilation anywhere.
- If a feature seems to need a dependency (YAML parsing, routing, diffing...), look first — a minimal in-house implementation usually already exists in `src/`.

## Project Structure

```
src/      core modules (pipeline, validation, scanning, storage, signing, audit, ...)
cli/      the agentdock command-line tool
web/      zero-dependency marketplace UI (vanilla JS)
tests/    node:test test suites
docs/     architecture and design documents
```

## Commit Messages

Follow the existing `type:` prefix style (see `git log`), with an optional scope:

```
feat: add export endpoint for marketplace catalog
feat(cli): support --profile merge for dsh-agent presets
fix(import): reject unsafe archive paths
docs: update architecture overview
perf(store): push list queries down to SQL
build: update CI matrix
chore(examples): regenerate sample bundles
```

Types in use: `feat`, `fix`, `docs`, `perf`, `build`, `chore`. Keep the subject line short and imperative; write the description in English or Chinese — both appear in the history.

## Pull Requests

Before opening a PR, make sure:

1. **Tests pass**: `npm test` and `npm run smoke` both succeed (run `npm run smoke:sqlite` too if you touched storage).
2. **New behavior has tests** — add cases under `tests/` using `node:test`.
3. **Documentation is in sync**: user-facing changes update `README.md`; architectural changes update `docs/ARCHITECTURE.md`.
4. **No new dependencies**: the diff must not add anything to `package.json` dependencies (there are none, and that is the point).

Describe what changed and why in the PR description, and link any related issues. See `.github/PULL_REQUEST_TEMPLATE.md`.

## Reporting Issues

- Bugs: use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- Feature ideas: use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- Security vulnerabilities: **do not open a public issue** — follow [SECURITY.md](SECURITY.md)
