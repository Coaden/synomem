import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { SynomemError } from './errors.js';

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function assertNoSymlinkEscape(home: string, target: string): void {
  const root = realpathSync(home);
  const lexicalRoot = resolve(home);
  const resolved = resolve(target);
  const rel = relative(lexicalRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(lexicalRoot, rel) !== resolved) {
    throw new SynomemError('UNSAFE_PATH', 'Path escapes the configured Synomem home.');
  }

  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SynomemError(
        'UNSAFE_PATH',
        `Refusing to traverse symbolic link: ${relative(root, current)}`,
      );
    }
  }
}

export function atomicWriteFile(path: string, content: string, mode = 0o600): void {
  atomicWrite(path, content, mode, true);
}

/** Atomically replace rebuildable derived data without forcing it to stable storage. */
export function atomicWriteDerivedFile(path: string, content: string, mode = 0o600): void {
  atomicWrite(path, content, mode, false);
}

function atomicWrite(path: string, content: string, mode: number, durable: boolean): void {
  ensureDirectory(dirname(path));
  const temporary = resolve(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    if (durable) fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    if (durable)
      try {
        const directoryDescriptor = openSync(dirname(path), 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EINVAL', 'EISDIR', 'EPERM'].includes(code ?? '')) throw error;
      }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
