import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  createNoteSchema,
  evidenceSchema,
  escapeMarkdown,
  giveKudosSchema,
} from '../src/index.js';

describe('validation and escaping', () => {
  it.each(['codex', 'gracie-p-tienamme', 'agent-42'])('accepts agent ID %s', (id) => {
    expect(agentIdSchema.parse(id)).toBe(id);
  });

  it.each([
    '',
    '..',
    '../codex',
    'Codex',
    'co/dex',
    'co\\dex',
    'kudos',
    'synomem',
    'con',
    '-codex',
    'codex-',
  ])('rejects unsafe or reserved agent ID %s', (id) => {
    expect(() => agentIdSchema.parse(id)).toThrow();
  });

  it('validates URL and repository-relative file evidence', () => {
    expect(
      evidenceSchema.parse({ kind: 'url', value: 'https://example.com/task/17' }),
    ).toBeTruthy();
    expect(evidenceSchema.parse({ kind: 'file', value: 'src/client.ts' })).toBeTruthy();
    expect(() => evidenceSchema.parse({ kind: 'url', value: 'file:///etc/passwd' })).toThrow();
    expect(() => evidenceSchema.parse({ kind: 'file', value: '../../secret.env' })).toThrow();
    expect(() => evidenceSchema.parse({ kind: 'file', value: '/etc/passwd' })).toThrow();
  });

  it('escapes untrusted Markdown and HTML', () => {
    expect(escapeMarkdown('# <script>*boom*</script>')).toBe(
      '\\# &lt;script&gt;\\*boom\\*&lt;/script&gt;',
    );
    expect(escapeMarkdown('Clear prose. Follow-up work.')).toBe('Clear prose. Follow-up work.');
  });

  it('requires single-line titles and applies the published tag grammar', () => {
    const base = {
      recipientAgentId: 'codex',
      reason: 'Concrete contribution.',
      visibility: 'workspace' as const,
    };
    expect(() => giveKudosSchema.parse({ ...base, title: 'Heading\ninjection' })).toThrow();
    expect(() =>
      giveKudosSchema.parse({ ...base, title: 'Valid title', tags: ['invalid tag'] }),
    ).toThrow();
    expect(
      giveKudosSchema.parse({ ...base, title: 'Valid title', tags: ['review.excellent'] }).tags,
    ).toEqual(['review.excellent']);
  });

  it('rejects attempts to share a note', () => {
    expect(() =>
      createNoteSchema.parse({
        title: 'Owner-only memory',
        body: 'Notes cannot be shared in V1.',
        visibility: 'workspace',
      }),
    ).toThrow();
  });
});
