import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const project = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'synomem-pack-'));
const npmEnv = {
  ...process.env,
  NPM_CONFIG_CACHE: join(temporary, 'npm-cache'),
  npm_config_dry_run: 'false',
};

try {
  const packJson = JSON.parse(
    // npm publish --dry-run exports npm_config_dry_run=true to lifecycle scripts. Override it here
    // because this smoke test must create and install the isolated tarball it is validating.
    run(
      'npm',
      ['pack', '--json', '--dry-run=false', '--pack-destination', temporary],
      project,
      npmEnv,
    ),
  );
  const packRecords = Array.isArray(packJson) ? packJson : Object.values(packJson);
  if (packRecords.length !== 1) throw new Error('npm pack returned an unexpected result.');
  const packed = packRecords[0];
  if (!packed?.filename || !Array.isArray(packed.files))
    throw new Error('npm pack returned no file manifest.');
  const names = packed.files.map((file) => file.path);
  for (const required of [
    'package.json',
    'README.md',
    'AGENTS.md',
    'ARCHITECTURE.md',
    'LICENSE',
    'docs/recovery.md',
    'dist/index.js',
    'dist/cli.js',
    'dist/mcp-server.js',
    'dist/remote.js',
    'dist/oauth.js',
    'dist/credentials.js',
    'dist/skill-install.js',
    'openapi/synomem-v1.yaml',
    'src/index.ts',
    'skills/synomem/SKILL.md',
  ]) {
    if (!names.includes(required)) throw new Error(`Tarball is missing ${required}.`);
  }
  const forbidden = names.filter(
    (name) =>
      name.startsWith('test/') ||
      name.includes('.agents/') ||
      name.endsWith('.sqlite3') ||
      name.startsWith('src/server/') ||
      name.startsWith('src/postgres/') ||
      name.startsWith('postgres/') ||
      name.startsWith('ops/') ||
      name === 'Dockerfile' ||
      name === 'compose.yaml' ||
      name.includes('server-main'),
  );
  if (forbidden.length)
    throw new Error(`Tarball contains forbidden files: ${forbidden.join(', ')}`);

  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    '{"name":"synomem-smoke","private":true,"type":"module"}\n',
  );
  const tarball = join(temporary, packed.filename);
  if (!existsSync(tarball)) throw new Error('Tarball was not created.');
  run('npm', ['install', '--ignore-scripts', tarball], consumer, npmEnv);
  const packageJson = JSON.parse(
    readFileSync(join(consumer, 'node_modules', 'synomem', 'package.json'), 'utf8'),
  );
  if (packageJson.name !== 'synomem') throw new Error('Installed package metadata is incorrect.');
  if (
    packageJson.bin?.synomem !== 'dist/cli.js' ||
    packageJson.bin?.['synomem-mcp'] !== 'dist/mcp-server.js'
  ) {
    throw new Error('Installed package binary metadata is incorrect.');
  }
  const synomemBin = join(consumer, 'node_modules', '.bin', 'synomem');
  const mcpBin = join(consumer, 'node_modules', '.bin', 'synomem-mcp');
  run(synomemBin, ['--help'], consumer);
  run(mcpBin, ['--help'], consumer);
  if (run(synomemBin, ['--version'], consumer).trim() !== packageJson.version)
    throw new Error('CLI version does not match package.json.');
  if (run(mcpBin, ['--version'], consumer).trim() !== packageJson.version)
    throw new Error('MCP binary version does not match package.json.');
  run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { SynomemClient, StoredCredentialProvider } from 'synomem'; if (!SynomemClient || !StoredCredentialProvider) process.exit(1)",
    ],
    consumer,
  );
  run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { createSynomemMcpServer } from 'synomem/mcp'; if (!createSynomemMcpServer) process.exit(1)",
    ],
    consumer,
  );

  const skillUser = join(temporary, 'skill-user');
  const codexHome = join(skillUser, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const skillEnv = {
    ...process.env,
    HOME: skillUser,
    USERPROFILE: skillUser,
    CODEX_HOME: codexHome,
  };
  run(synomemBin, ['skill', 'install', '--runtime', 'codex'], consumer, skillEnv);
  const installedSkill = join(codexHome, 'skills', 'synomem', 'SKILL.md');
  if (existsSync(installedSkill)) throw new Error('Skill dry run unexpectedly wrote files.');
  run(
    synomemBin,
    ['skill', 'install', '--runtime', 'codex', '--actor-id', 'codex', '--yes'],
    consumer,
    skillEnv,
  );
  if (!existsSync(installedSkill))
    throw new Error('Installed package could not install its skill.');
  const installedSkillStatus = JSON.parse(
    run(synomemBin, ['skill', 'status', '--runtime', 'codex', '--json'], consumer, skillEnv),
  );
  if (installedSkillStatus.locations?.[0]?.state !== 'current') {
    throw new Error('Installed skill did not report current status.');
  }
  run(synomemBin, ['skill', 'uninstall', '--runtime', 'codex', '--yes'], consumer, skillEnv);
  if (existsSync(installedSkill)) throw new Error('Skill uninstall left installed files behind.');

  const acceptanceHome = join(temporary, 'acceptance', '.agents');
  const acceptanceEnv = { ...process.env, SYNOMEM_HOME: acceptanceHome };
  run(synomemBin, ['init'], consumer, acceptanceEnv);
  run(
    synomemBin,
    ['agent', 'create', 'gracie', '--name', 'Gracie P. Tienammè'],
    consumer,
    acceptanceEnv,
  );
  run(synomemBin, ['agent', 'create', 'codex', '--name', 'Codex'], consumer, acceptanceEnv);
  const giveArgs = [
    'kudos',
    'give',
    'codex',
    '--from',
    'gracie',
    '--actor-kind',
    'agent',
    '--title',
    'Caught a continuity contradiction',
    '--reason',
    'Found conflicting E17 requirements before implementation, preventing work against the wrong assumption.',
    '--tag',
    'review',
    '--tag',
    'continuity',
    '--evidence',
    'task:E17',
    '--visibility',
    'workspace',
    '--idempotency-key',
    'acceptance-gracie-codex-e17',
    '--json',
  ];
  const given = JSON.parse(run(synomemBin, giveArgs, consumer, acceptanceEnv));
  const kudosId = given.record?.event?.id;
  if (!kudosId || given.deduplicated) throw new Error('Acceptance kudos was not created.');
  if (!run(synomemBin, ['inbox', 'codex'], consumer, acceptanceEnv).includes(kudosId)) {
    throw new Error('Acceptance inbox did not contain the new kudos.');
  }
  if (
    !run(synomemBin, ['kudos', 'wins', 'codex', '--print'], consumer, acceptanceEnv).includes(
      kudosId,
    )
  ) {
    throw new Error('Acceptance WINS.md did not contain the new kudos.');
  }
  run(
    synomemBin,
    ['kudos', 'acknowledge', kudosId, '--as', 'codex', '--actor-kind', 'agent'],
    consumer,
    acceptanceEnv,
  );
  run(synomemBin, ['kudos', 'show', kudosId, '--json'], consumer, acceptanceEnv);
  run(synomemBin, ['kudos', 'stats', '--json'], consumer, acceptanceEnv);

  const memo = JSON.parse(
    run(
      synomemBin,
      [
        'memo',
        'send',
        'codex',
        '--from',
        'gracie',
        '--subject',
        'Review decision',
        '--body',
        'The acceptance path now covers every domain.',
        '--json',
      ],
      consumer,
      acceptanceEnv,
    ),
  );
  if (!memo.record?.event?.id) throw new Error('Acceptance memo was not created.');
  const note = JSON.parse(
    run(
      synomemBin,
      [
        'note',
        'create',
        '--as',
        'codex',
        '--title',
        'Local convention',
        '--body',
        'Canonical state is append-only.',
        '--json',
      ],
      consumer,
      acceptanceEnv,
    ),
  );
  if (!note.record?.event?.id) throw new Error('Acceptance note was not created.');
  const task = JSON.parse(
    run(
      synomemBin,
      [
        'task',
        'create',
        'codex',
        '--from',
        'gracie',
        '--title',
        'Review package acceptance',
        '--due-date',
        '2026-09-15',
        '--json',
      ],
      consumer,
      acceptanceEnv,
    ),
  );
  const taskId = task.record?.event?.id;
  if (!taskId || task.record?.status !== 'assigned')
    throw new Error('Assigned task was not created.');
  run(synomemBin, ['task', 'accept', taskId, '--as', 'codex'], consumer, acceptanceEnv);
  const unified = JSON.parse(
    run(synomemBin, ['list', '--limit', '20', '--json'], consumer, acceptanceEnv),
  );
  if (new Set(unified.items?.map((item) => item.kind)).size !== 4) {
    throw new Error('Unified acceptance list did not contain every domain.');
  }

  run(synomemBin, ['doctor'], consumer, acceptanceEnv);
  run(synomemBin, ['rebuild'], consumer, acceptanceEnv);
  run(synomemBin, ['export', '--format', 'jsonl'], consumer, acceptanceEnv);
  const retry = JSON.parse(run(synomemBin, giveArgs, consumer, acceptanceEnv));
  if (!retry.deduplicated || retry.record?.event?.id !== kudosId) {
    throw new Error('Acceptance retry did not return the original kudos.');
  }
  if (!existsSync(join(acceptanceHome, 'synomem', 'synomem.sqlite3'))) {
    throw new Error('Acceptance database is missing.');
  }
  if (!readFileSync(join(acceptanceHome, 'codex', 'WINS.md'), 'utf8').includes(kudosId)) {
    throw new Error('Acceptance projection is missing.');
  }
  process.stdout.write(`Package smoke test passed: ${packed.filename} (${names.length} files)\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
