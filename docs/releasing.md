---
layout: default
title: Releasing
---

# Releasing

Publishing is intentionally separate from ordinary CI and requires maintainer authorization.

## Bootstrap release

An npm trusted publisher can be configured only after the package exists in the registry. The first
release therefore requires an explicitly authorized, interactive publish by the maintainer:

1. Confirm `npm whoami` reports the intended account and account-level two-factor authentication is enabled.
2. Run every quality gate and inspect `npm publish --dry-run`.
3. Publish once with `npm publish --access public`; complete the interactive authentication prompt.
4. Verify the package name, version, files, binaries, and repository link on npm before continuing.

Create the `v0.1.0` GitHub Release only after this bootstrap publish succeeds. The release workflow
reruns the gates, verifies the tag, detects that the exact registry version already exists, and
idempotently skips the duplicate publish.

## Trusted publishing setup

After the bootstrap package exists:

1. On npmjs.com, configure a trusted publisher for:
   - GitHub owner: `Coaden`
   - Repository: `synomem`
   - Workflow filename: `release.yml`
   - Environment: `npm` if environment protection is enabled
   - Allowed action: `npm publish`
2. In GitHub, create an `npm` environment and preferably require maintainer approval.
3. Enable GitHub Pages with **GitHub Actions** as the source.

The release workflow uses OIDC trusted publishing, requires no long-lived npm token, and receives only `contents: read` and `id-token: write` permissions. npm trusted publishing generates provenance automatically for this public repository/package combination.

## Subsequent release checklist

1. Update `CHANGELOG.md` and remove the `Unreleased` placeholder for the version.
2. Set the version with `npm version <major|minor|patch>` and review the generated commit/tag.
3. Run:

   ```bash
   npm ci
   npm run format:check
   npm run lint
   npm run typecheck
   npm test
   npm run test:coverage
   npm run pack:check
   npm pack --dry-run
   ```

4. Push the version commit and tag.
5. Create an intentional GitHub Release for the tag.
6. Review the `Release npm package` workflow and protected environment approval.
7. Verify the npm page, provenance, tarball contents, both binaries, package exports, repository URL, and release notes.

Do not publish from a developer laptop as the normal path, do not add an `NPM_TOKEN` fallback casually, and do not reuse the Pages workflow for npm publication.
