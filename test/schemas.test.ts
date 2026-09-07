import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  createNoteSchema,
  eventSchema,
  profileSchema,
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

/*
 * A record written before handles existed.
 *
 * Agents gained a handle alongside their canonical ID in schema 7. Events from
 * before that carry an id and no handle, and they live in an append-only log,
 * so the reader has to accept them rather than the log being rewritten. One
 * such agent made the compatibility check refuse an entire workspace's event
 * stream, and every write there failed with UNSUPPORTED_EVENT.
 *
 * The payload below is verbatim from the database where that happened.
 */
describe('records written before handles existed', () => {
  const storedEvent = {
    id: '01M1W0YVYYS99TJK2JA82J6XWK',
    type: 'agent.created',
    actor: { id: 'act-xcb6bkjt2a3afwagxeqpga7ws5', kind: 'human', displayName: 'Coaden' },
    agent: {
      id: 'mycroft',
      aliases: ['mike'],
      createdAt: '2026-09-06T18:51:12.734Z',
      description: 'Main Hermes Agent.',
      displayName: 'Mycroft',
    },
    createdAt: '2026-09-06T18:51:12.734Z',
    aggregateId: 'mycroft',
    workspaceId: 'ws-m6w57xvemgk68gxxm7tnbzrwrs',
    schemaVersion: 1,
    aggregateVersion: 1,
  };

  it('reads a pre-handle agent.created event, taking the ID as the handle', () => {
    const event = eventSchema.parse(storedEvent);
    // Back then the ID was the name people typed, so it is the correct handle
    // rather than a placeholder.
    expect(event).toMatchObject({ type: 'agent.created', agent: { handle: 'mycroft' } });
  });

  it('defaults the status of a record written before archiving existed', () => {
    expect(profileSchema.parse(storedEvent.agent)).toMatchObject({
      handle: 'mycroft',
      status: 'active',
    });
  });

  it('still refuses a profile with neither an id nor a handle', () => {
    // The fallback must not become a way to write a nameless agent.
    expect(() =>
      profileSchema.parse({ displayName: 'Nameless', createdAt: '2026-09-06T18:51:12.734Z' }),
    ).toThrow();
  });

  it('leaves a handle alone when the record has one', () => {
    expect(
      profileSchema.parse({
        ...storedEvent.agent,
        id: '01M1YHX82YFH2AMADB0H5YH84B',
        handle: 'holmes',
      }),
    ).toMatchObject({ id: '01M1YHX82YFH2AMADB0H5YH84B', handle: 'holmes' });
  });
});
