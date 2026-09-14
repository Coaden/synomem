import { chmodSync } from 'node:fs';

// `tsc` never sets the executable bit on emitted files, shebang or not — and
// npm's own runtime chmod of `bin`-listed files on install is not reliable
// enough to depend on (confirmed: a fresh `npm install -g synomem` left both
// binaries at 644). The published tarball has to store them executable
// itself, which only this build step can guarantee.
for (const path of ['dist/cli.js', 'dist/mcp-server.js']) {
  chmodSync(path, 0o755);
}
