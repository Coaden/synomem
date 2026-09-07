/**
 * A small prompt boundary, injectable so the wizard is testable.
 *
 * Deliberately not a dependency: the wizard needs a select, a line, a masked
 * line and a confirm, and a library for that would be more surface than
 * substance. Everything reads from an injected stream, so tests drive the flow
 * without a terminal.
 */
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export interface PromptIo {
  input: Readable;
  output: Writable;
  /**
   * Whether a person is actually there. A wizard must never wait forever on a
   * pipe, so a non-interactive stream is refused with instructions instead.
   */
  interactive: boolean;
}

export function defaultPromptIo(): PromptIo {
  return {
    input: process.stdin,
    output: process.stdout,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

async function readLine(io: PromptIo, question: string): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: io.interactive });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function ask(io: PromptIo, question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = await readLine(io, `${question}${suffix}: `);
  return answer || fallback || '';
}

export async function confirm(io: PromptIo, question: string): Promise<boolean> {
  const answer = await readLine(io, `${question} [y/N]: `);
  return /^y(es)?$/i.test(answer);
}

/**
 * Reads a secret from a non-interactive stream, or prompts for one.
 *
 * Piping a secret in is the SAFE path and is why this accepts a closed stream
 * rather than refusing it: a token passed as a command-line argument is kept by
 * both the shell history and the process list, so `--access-token-stdin` has to
 * work without a terminal.
 */
export async function askSecret(io: PromptIo, question: string): Promise<string> {
  if (!io.interactive) {
    const chunks: Buffer[] = [];
    for await (const chunk of io.input) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // Readline echoes, so an interactive secret is read the same way and the
  // caller is told not to expect masking rather than being silently exposed.
  io.output.write('The value you type will be visible. Paste it, or pipe it in instead.\n');
  return await readLine(io, `${question}: `);
}

export async function select<T extends string>(
  io: PromptIo,
  question: string,
  choices: Array<{ value: T; label: string; detail?: string }>,
): Promise<T> {
  io.output.write(`\n${question}\n\n`);
  choices.forEach((choice, index) => {
    io.output.write(`  ${index + 1}) ${choice.label}\n`);
    if (choice.detail) io.output.write(`     ${choice.detail}\n`);
  });
  io.output.write('\n');
  for (;;) {
    const answer = await readLine(io, `Choose 1-${choices.length} [1]: `);
    const index = Number(answer || '1');
    const choice = choices[index - 1];
    if (choice) return choice.value;
    io.output.write('Enter one of the listed numbers.\n');
  }
}
