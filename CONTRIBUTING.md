# Contributing to Synomem

Thank you for helping make durable agent coordination more useful—and slightly more robotic.

## Before opening a change

For substantial features, open an issue first so scope and storage compatibility can be discussed. Security reports belong in GitHub private vulnerability reporting, not public issues.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

```bash
git clone https://github.com/Coaden/synomem.git
cd synomem
npm install
npm test
```

Node.js 22.13 or newer is required. The project uses ESM, strict TypeScript, Node’s built-in SQLite module, Vitest, ESLint, and Prettier.

## Pull requests

1. Create a focused branch from `main`.
2. Add or update tests for observable behavior and security boundaries.
3. Update documentation and `CHANGELOG.md` when public behavior changes.
4. Run every quality gate:

   ```bash
   npm run format:check
   npm run lint
   npm run typecheck
   npm test
   npm run test:coverage
   npm run pack:check
   ```

5. Explain the motivation, implementation, tests, and storage or security impact in the pull request.

Keep commits reviewable. Do not commit real Synomem homes, databases, secrets, build output, coverage, or tarballs.

## Design expectations

Preserve the invariants in [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md). New event types require validation, migration consideration, query/projection behavior, protocol tests, documentation, and export coverage.

## Releases

Maintainers follow [docs/releasing.md](docs/releasing.md). Ordinary CI never publishes packages. Publishing requires an intentional GitHub Release and an npm trusted-publisher relationship.
