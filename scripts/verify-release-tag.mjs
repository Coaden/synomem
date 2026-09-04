import { readFileSync } from 'node:fs';

const tag = process.argv[2];
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expected = `v${packageJson.version}`;

if (tag !== expected) {
  process.stderr.write(
    `Release tag ${tag ?? '<missing>'} does not match package version ${expected}.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Release tag ${tag} matches package version ${packageJson.version}.\n`);
}
