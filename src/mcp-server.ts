#!/usr/bin/env node
/**
 * The stdio MCP entry point.
 *
 * `startMcpServer` runs the shared tool catalog for one context resolver: a fixed
 * profile (one pinned workspace/actor) or an explicit preset (several, selected per
 * call). Which resolver is decided by the CLI's profile resolution (identity contract
 * §6.1), so `synomem-mcp <args>` is exactly `synomem mcp <args>` — one resolution
 * implementation for every entry point, never a second set of identity flags here.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serveStdio } from './mcp/index.js';
import type { ContextResolver } from './resolvers.js';

export async function startMcpServer(options: {
  resolver: ContextResolver;
  instructions?: string;
}): Promise<void> {
  const runtime = await serveStdio(options.resolver, {
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
  await new Promise<void>((resolve) => {
    const previous = runtime.server.server.onclose;
    runtime.server.server.onclose = () => {
      previous?.();
      resolve();
    };
  });
  await options.resolver.close?.();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { runCli } = await import('./cli.js');
  process.exitCode = await runCli([
    process.argv[0] ?? 'node',
    process.argv[1],
    'mcp',
    ...process.argv.slice(2),
  ]);
}
