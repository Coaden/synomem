import { readFileSync } from 'node:fs';

let cachedVersion: string | undefined;

/** Read the installed package metadata lazily so every runtime surface reports one version. */
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('synomem package.json has no valid version.');
  }
  cachedVersion = metadata.version;
  return cachedVersion;
}
