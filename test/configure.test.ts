import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  assertInteractive,
  credentialFingerprint,
  credentialStoreChoices,
  environmentInstructions,
  writeCredentialFile,
} from '../src/configure.js';
import type { PromptIo } from '../src/prompt.js';
import { tempHome } from './helpers.js';

function scriptedIo(lines: string[]): PromptIo & { written: string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  return {
    input,
    output,
    interactive: true,
    get written() {
      return written;
    },
  };
}

describe('onboarding configuration', () => {
  it('refuses to prompt when nobody is there, and says what to run instead', () => {
    const io = { ...scriptedIo([]), interactive: false };
    let message = '';
    try {
      assertInteractive(io);
    } catch (error) {
      message = (error as Error).message;
    }
    // A setup program that blocks forever on a pipe is worse than one that
    // names the flags it needs.
    expect(message).toContain('needs an interactive terminal');
    expect(message).toContain('config init --backend local --yes');
    expect(message).toContain('--access-token-stdin');
  });

  it('stores an access key in a file only the owner can read', () => {
    const home = tempHome();
    const path = writeCredentialFile(home, 'syn_abcdef0123456789');

    expect(path).toBe(join(home, 'credentials', 'installation.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'credentials')).mode & 0o777).toBe(0o700);

    // Kept out of config.json so a configuration file can be shared without
    // carrying a secret with it.
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { accessToken: string };
    expect(stored.accessToken).toBe('syn_abcdef0123456789');
  });

  it('identifies a credential by prefix and never in full', () => {
    const token = 'syn_abcdef0123456789_secret_tail';
    const shown = credentialFingerprint(token);
    expect(token.startsWith(shown.replace('\u2026', ''))).toBe(true);
    expect(shown).not.toContain('secret_tail');
    expect(shown.length).toBeLessThan(token.length);
  });

  it('prints environment instructions rather than editing a shell profile', () => {
    const text = environmentInstructions('syn_token');
    expect(text).toContain("export SYNOMEM_ACCESS_TOKEN='syn_token'");
    // Silently rewriting a dotfile is not a thing a setup program should do.
    expect(text).toContain('will not edit your shell profile');
  });

  it('offers only credential stores that exist on the platform', () => {
    expect(credentialStoreChoices('darwin')[0]?.label).toContain('Keychain');
    // Windows Credential Manager is not implemented in the credential layer,
    // so the wizard must not offer it: a choice that fails on first use is
    // worse than a plainly second-best one.
    expect(credentialStoreChoices('win32').map((choice) => choice.value)).not.toContain('keychain');
    expect(credentialStoreChoices('win32')[0]?.value).toBe('file');
    expect(credentialStoreChoices('linux')[0]?.label).toContain('Secret Service');
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const values = credentialStoreChoices(platform).map((choice) => choice.value);
      // A restricted file and printed instructions work everywhere, so a
      // headless machine with no keyring is never left without an option.
      expect(values).toContain('file');
      expect(values).toContain('environment');
      // And each option is offered exactly once, whichever is recommended.
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

/*
 * Remote setup used to ask a person to type `ws-04psqx2rkt8ttft7a1t2z69r97`
 * from memory. An installation access key is bound to exactly one workspace,
 * so the service can be asked instead.
 */
describe('remote setup', () => {
  it('takes the workspace from the access key rather than asking for it', async () => {
    const { runCli } = await import('../src/cli.js');
    const home = tempHome();
    const lines: string[] = [];
    const io = { stdout: (t: string) => lines.push(t), stderr: (t: string) => lines.push(t) };

    const discovered: string[] = [];
    const code = await runCli(
      [
        'node',
        'synomem',
        '--home',
        home,
        'config',
        'init',
        '--backend',
        'remote',
        '--auth',
        'access-key',
        '--access-token-stdin',
        '--credential-store',
        'file',
        '--yes',
      ],
      io,
      undefined,
      {
        // Piped, not typed: `--access-token-stdin` reads the whole stream, so
        // the key never becomes a shell-history entry or a process argument.
        promptIo: { ...scriptedIo(['installation-key-secret']), interactive: false },
        // Kept off the network: the closing diagnostics reach the configured
        // service, and a test must not depend on the real one being up.
        env: { ...process.env, SYNOMEM_API_URL: 'http://127.0.0.1:1' },
        discoverBoundWorkspace: async ({ accessToken }) => {
          discovered.push(accessToken);
          return { workspaceId: 'ws-04psqx2rkt8ttft7a1t2z69r97' };
        },
      },
    );

    // A non-zero code here is the unreachable stub service, not the setup: the
    // configuration and the credential are both written before diagnostics run.
    expect([0, 4, 5]).toContain(code);
    // The key was what answered the question, and it never reached the output.
    expect(discovered).toEqual(['installation-key-secret']);
    const printed = lines.join('');
    expect(printed).toContain('ws-04psqx2rkt8ttft7a1t2z69r97');
    expect(printed).not.toContain('installation-key-secret');
    expect(
      JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
        backend: { kind: string; workspaceId: string };
      },
    ).toMatchObject({
      backend: { kind: 'remote', workspaceId: 'ws-04psqx2rkt8ttft7a1t2z69r97' },
    });
  });

  it('still requires an explicit workspace when there is no key to ask', async () => {
    const { runCli } = await import('../src/cli.js');
    const lines: string[] = [];
    const io = { stdout: (t: string) => lines.push(t), stderr: (t: string) => lines.push(t) };
    expect(
      await runCli(
        ['node', 'synomem', '--home', tempHome(), 'config', 'init', '--backend', 'remote', '--yes'],
        io,
      ),
    ).toBe(2);
    expect(lines.join('')).toContain('--workspace');
  });
});

describe('reset', () => {
  it('names exact targets, and removes nothing until told', async () => {
    const { runCli } = await import('../src/cli.js');
    const home = tempHome();
    const lines: string[] = [];
    const io = { stdout: (t: string) => lines.push(t), stderr: (t: string) => lines.push(t) };

    expect(
      await runCli(
        ['node', 'synomem', '--home', home, 'config', 'init', '--backend', 'local', '--yes'],
        io,
      ),
    ).toBe(0);
    const database = join(home, 'synomem.sqlite3');
    expect(existsSync(database)).toBe(true);

    lines.length = 0;
    expect(await runCli(['node', 'synomem', '--home', home, 'reset'], io)).toBe(0);
    const preview = lines.join('');
    // Every target is shown before anything is touched, and nothing is
    // derived from a variable that might be empty.
    expect(preview).toContain(database);
    expect(preview).toContain('Run with --yes to continue.');
    expect(preview).toContain('Installed skills and MCP registrations are left alone.');
    expect(existsSync(database)).toBe(true);

    lines.length = 0;
    expect(await runCli(['node', 'synomem', '--home', home, 'reset', '--yes'], io)).toBe(0);
    expect(existsSync(database)).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});
