# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.0   | yes       |

AgentDock is at its first public release; only the latest published version receives security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, email us privately:

<!-- TODO: 替换为真实安全联系邮箱 -->
**security@example.com**

<!-- TODO: 可选：补充 PGP 公钥指纹或安全披露渠道（如 GitHub private vulnerability reporting） -->

Please include as much of the following as you can:

- The affected component and version (`package.json` version, deployment method: npm / Docker)
- Step-by-step instructions or a minimal proof of concept to reproduce
- The impact you believe the issue has, and any suggested mitigation

## Response Timeline

- **Acknowledgment**: within **48 hours** of your report
- **Assessment**: within **7 days**, we will confirm whether it is a security issue, its severity, and the plan for a fix
- We will keep you informed throughout and credit you in the release notes unless you prefer to remain anonymous

## Security Features (for context when reporting)

AgentDock is a self-hosted capability marketplace with governance built in. The following existing mechanisms may be relevant to your analysis:

- **Static security scanning** — heuristic rule engine (prompt injection, data exfiltration, credential leakage, dangerous commands, hidden instructions, Trojan Source, etc.); high-severity findings block publishing by default; supply-chain checks flag typo-squatting names and diff-injected updates
- **Content signing** — every published version is signed with the platform ed25519 key; public keys are served via `GET /api/v1/keys` and signatures can be verified offline; verification recomputes on-disk content hashes to detect storage tampering
- **Publisher signatures** (optional) — publishers can sign with their own ed25519 keys (TOFU registration)
- **Verifiable transparency log** — append-only hash chain + RFC 6962-style Merkle tree over publish events, with locally verifiable inclusion proofs
- **Audit log** — append-only JSONL with a tamper-evident hash chain (`agentdock audit verify`), rotation archiving, and CSV/JSONL export
- Also relevant: token hashing with timing-safe comparison, per-IP rate limiting, CSRF double-submit for cookie sessions, OIDC SSO with MFA enforcement, path sanitization and size limits on all package content, and SSRF-safe external registry imports.

Note that the scanner is heuristic, not a sandbox: it cannot catch all semantic or conditional injections, and human review remains part of the pipeline. If you find a bypass of this kind, we still want to hear about it.

## Deployment Note

The server binds to `127.0.0.1` by default and ships without TLS. Public deployments should sit behind a reverse proxy that terminates TLS and restrict access to `/api/v1/admin/*` — see the README's deployment section.
