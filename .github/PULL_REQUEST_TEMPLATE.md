## Description

<!-- What does this PR change and why? Link related issues with "Fixes #123". -->

## Type of Change

<!-- Check all that apply. -->

- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`)
- [ ] Performance improvement (`perf:`)
- [ ] Documentation (`docs:`)
- [ ] Build / CI (`build:`)
- [ ] Chore / refactor (`chore:`)
- [ ] Breaking change (fix or feature that would cause existing behavior to change)

## How Has This Been Tested?

<!-- Describe how you verified the change. -->

- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `npm run smoke:sqlite` (required if storage/backend code changed, Node 24+)
- [ ] New tests added for the changed behavior

## Documentation

- [ ] `README.md` updated (user-facing behavior, CLI flags, config, API)
- [ ] `docs/ARCHITECTURE.md` updated (module responsibilities, data model, security model)
- [ ] `CHANGELOG.md` has an entry under the unreleased section
- [ ] No docs change needed

## Self-Review Checklist

- [ ] Zero third-party dependencies: only `node:` built-in modules are used, and `node:test` for tests
- [ ] No new config surface without a default (environment variables documented)
- [ ] Security-relevant changes (scanning, signing, audit, auth, path handling) include tests
- [ ] Commit messages follow the `type:` prefix convention (see CONTRIBUTING.md)
