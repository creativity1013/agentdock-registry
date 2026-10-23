# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-23

First public release. AgentDock is a cross-harness AI capability marketplace and governance platform for skill / agent / plugin packages, built with zero third-party dependencies on the Node.js standard library.

### Added

- Cross-harness capability marketplace and governance platform: a full publish → validate → security scan → review → install → audit pipeline for `skill`, `agent`, and `plugin` packages, with immutable published versions and content hashes
- CLI (`cli/agentdock.mjs`): login, verify, publish, list, review, install, audit, tokens, import-claude, keygen/signing, transparency, sbom, policy, sync, backup commands
- Zero-dependency web marketplace UI: pagination with server-side search, safe markdown rendering, and a file-level plus line-level diff view for pending versions
- `dsh-agent` install target: renders agent packages into DSH agent-preset fragments, with idempotent merge into a DSH profile via `--profile`
- Install targets for `dsh`, `claude`, `codex`, `shared`, and arbitrary directories; install manifests power `outdated`, `upgrade`, `rollback`, and `uninstall` with recent-version history
- Pre-install local re-scan and signature verification by default, with `--allow-risk` / `--no-verify` opt-outs
- Static security scanning rule engine: prompt injection, data exfiltration, credential leakage, dangerous commands, dynamic execution, persistence/harness tampering, hidden instructions (zero-width chars, Trojan Source, homoglyphs), plus structural checks (description poisoning, npm lifecycle scripts, agent tool combinations) and severity rationale in findings
- Supply-chain checks at publish time: typo-squatting name detection against existing packages (`SUP-001`) and diff-increment scanning against the previous version (`SUP-002`)
- Optional AI-assisted review (advisory only, off by default): pending versions with scan hits are sent to an OpenAI-compatible endpoint for a second semantic-level verdict
- Platform ed25519 content signing on approval, with offline-verifiable public keys and disk-content tamper detection; optional publisher signatures with TOFU key registration
- Verifiable transparency log: append-only hash chain with an RFC 6962-style Merkle tree and locally verifiable inclusion proofs
- Tamper-evident audit log: append-only JSONL with `seq/prevHash/hash` chain, filtering, `audit verify`, rotation archiving, and CSV/JSONL export; tenant-filtered audit views
- SBOM generation (`agentdock-sbom@1`) per published version: file hashes plus declared tool/MCP/skill components with a reproducible digest
- Policy-based auto-approval (`agentdock-policy@1`), editable from the web admin policy page, with tenant-scoped policies and quotas (packages, versions per package, storage bytes)
- Quality tiers (community / verified / official) derived from signing, review, and scan metadata, shown in the marketplace and CLI
- External registry interop: GitHub and MCP registry import (pull-only, same validate/scan/review pipeline), GitHub push via Git Data API as a single commit, and a neutral marketplace catalog export (`agentdock-marketplace@1`)
- Diverse import formats: directories, JSON bundles, `.zip` / `.tar.gz` archives, bare `.md` and `plugin.json` files, and browser folder upload with batch import, nested archive extraction, and up to 100 MB per package
- SSO login via OIDC Authorization Code + PKCE with auto-provisioning, group-to-role mapping, MFA (`amr`) enforcement, and HMAC-signed session cookies with per-user and global revocation
- Multi-tenant isolation: tenant-scoped marketplace, review queue, stats, and cross-tenant 404s; same package names allowed across tenants
- Per-IP sliding-window rate limiting on API and login endpoints, and CSRF double-submit protection plus Origin checks for cookie sessions
- Webhook/IM event notifications (Slack, Discord, Feishu, DingTalk, WeCom, generic JSON) with optional HMAC-SHA256 signing and failure-only auditing
- Zero-dependency backup and restore: gzip archive with per-file sha256 checksums and path-safety validation
- Review queue grouped by scan risk (high/medium/low/clean) with kind and risk filters, and single or batch deletion of pending versions
- Docker image (`node:24-alpine` + tini, non-root, `/data` volume, healthcheck), `docker-compose.yml`, and a production deployment example with Caddy automatic HTTPS
- GitHub Actions CI: Node 20/22/24 test matrix plus a Docker build job with container health checks

### Changed

- Market list and stats queries are pushed down to SQL on the SQLite backend; the JSON backend keeps its in-memory implementation (both paths covered by parity tests)
- `cli/agentdock.mjs` is executable so `npm link` provides a global `agentdock` command
- Import size limits raised to 100 MB total (folders, archives, directories)

### Security

- Tokens are stored as sha256 hashes only and compared with `crypto.timingSafeEqual`; bootstrap tokens are written to a 600-permission file and are meant to be rotated
- All package paths are sanitized (no absolute paths, `..`, hidden files, Windows reserved names, `node_modules`) with strict size and count limits; archive extraction is protected against zip bombs
- External registry imports are restricted to server-configured base URLs (no arbitrary URLs, SSRF-safe) and always land in the pending review queue

### Fixed

- Folder import now filters hidden/system files and returns specific validation errors
- Package root detection works at any nesting depth; static assets are served with no-cache; missing manifests produce a clear error
- Server-side install returns a clear `400 INSTALL_TARGET_UNWRITABLE` error when the target directory is not writable
- Member-local install commands are directly copy-pasteable (no placeholder syntax in copied commands)
- Working `agentdock` command entry point with one-click copy of token-bearing install commands

### Docs

- Architecture document covering layering, data model, request lifecycle, security model, and design trade-offs
- Deployment and usage runbook for new teams

<!-- TODO: 替换为真实仓库地址 -->
[0.1.0]: https://github.com/<owner>/agentdock/releases/tag/v0.1.0
