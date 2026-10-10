import { z } from 'zod';

/**
 * Hosted email (remote connections only). A mailbox belongs to the agent's immutable id;
 * addresses can be renamed by a human operator without moving any mail. Sending is a
 * capability an operator grants per agent, with rate limits and an audit trail on the server.
 */

export const EMAIL_FOLDERS = ['inbox', 'sent', 'drafts', 'spam', 'archive', 'trash'] as const;
export type EmailFolder = (typeof EMAIL_FOLDERS)[number];

export interface EmailParty {
  address: string;
  name?: string;
}

export interface EmailMessageSummary {
  id: string;
  folder: EmailFolder;
  direction: 'inbound' | 'outbound';
  threadId: string;
  from: EmailParty | null;
  to: EmailParty[];
  cc: EmailParty[];
  subject: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  attachmentCount: number;
  deliveryStatus?: string | null;
  spamScore?: number;
  date: string;
}

export interface EmailMessage extends EmailMessageSummary {
  bcc: EmailParty[];
  replyTo: EmailParty[];
  mailboxAddress: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html?: string;
  hasHtml: boolean;
  attachments: {
    index: number;
    filename: string;
    contentType: string;
    size: number;
    inline: boolean;
  }[];
  authentication?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  queueId?: string | null;
  sizeBytes: number;
  untrustedContent: boolean;
}

export interface EmailMessagePage {
  messages: EmailMessageSummary[];
  nextCursor?: string;
}

export interface EmailAttachmentContent {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentBase64: string;
}

export interface EmailMailbox {
  id: string;
  agentId: string;
  status: 'active' | 'disabled';
  primaryAddress: string | null;
  addresses: {
    id: string;
    address: string;
    displayName: string | null;
    kind: 'default' | 'chosen';
    primary: boolean;
    status: 'active' | 'retired';
  }[];
  sending: {
    policy: 'off' | 'internal' | 'external';
    suspended: boolean;
    suspendedReason: string | null;
    organizationOutboundEnabled: boolean;
    deploymentOutboundEnabled: boolean;
    limits: {
      hourly: number;
      daily: number;
      maxRecipientsPerMessage: number;
      newExternalRecipientsPerDay: number;
    };
    usage: { lastHour: number; lastDay: number; newExternalRecipientsLastDay: number };
  };
  folders: Record<EmailFolder, { total: number; unread: number }>;
}

const recipientList = z
  .union([z.string().min(3).max(1000), z.array(z.string().min(3).max(1000)).max(100)])
  .describe('One address or a list; each may be "a@b.com" or "Name <a@b.com>".');
const messageId = z.string().min(5).max(80).describe('Message id from synomem_email_list.');
const attachments = z
  .array(
    z
      .object({
        filename: z.string().min(1).max(255),
        contentType: z.string().max(255).optional(),
        contentBase64: z.string().min(1),
      })
      .strict(),
  )
  .max(20)
  .optional()
  .describe('Files to attach, base64-encoded.');
const body = {
  text: z.string().max(1_000_000).optional().describe('Plain-text body.'),
  html: z.string().max(2_000_000).optional().describe('Optional HTML body.'),
};
const fromAddress = z
  .string()
  .max(320)
  .optional()
  .describe('Send as this one of your own addresses; defaults to your primary address.');

export const emailListSchema = z
  .object({
    folder: z
      .enum([...EMAIL_FOLDERS, 'all'])
      .optional()
      .describe('Default: every folder except spam and trash.'),
    unread: z.boolean().optional(),
    flagged: z.boolean().optional(),
    from: z.string().max(320).optional().describe('Sender address contains this text.'),
    since: z.string().datetime({ offset: true }).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(4096).optional(),
  })
  .strict();
export type EmailListInput = z.infer<typeof emailListSchema> & { q?: string; threadId?: string };

export const emailSearchSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe('Words or phrases to find in subject, sender, recipients and body.'),
    folder: z.enum([...EMAIL_FOLDERS, 'all']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(4096).optional(),
  })
  .strict();

export const emailReadSchema = z
  .object({
    messageId,
    includeHtml: z.boolean().optional().describe('Also return the HTML body when there is one.'),
    markSeen: z.boolean().optional().describe('Mark as read (default true).'),
  })
  .strict();

export const emailThreadSchema = z.object({ threadId: z.string().min(5).max(80) }).strict();

export const emailAttachmentSchema = z
  .object({ messageId, index: z.number().int().min(0).max(100) })
  .strict();

export const emailSendSchema = z
  .object({
    to: recipientList,
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    subject: z.string().max(998),
    ...body,
    attachments,
    fromAddress,
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict();
export type EmailComposeInput = z.infer<typeof emailSendSchema>;

export const emailReplySchema = z
  .object({
    messageId,
    text: z
      .string()
      .max(1_000_000)
      .describe('Your reply. The original is quoted below it unless quote is false.'),
    html: body.html,
    replyAll: z.boolean().optional().describe('Also reply to everyone else on the original.'),
    quote: z.boolean().optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    attachments,
    fromAddress,
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict();
export type EmailReplyInput = z.infer<typeof emailReplySchema>;

export const emailForwardSchema = z
  .object({
    messageId,
    to: recipientList,
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    text: z.string().max(1_000_000).optional().describe('A note above the forwarded message.'),
    includeAttachments: z
      .boolean()
      .optional()
      .describe('Forward the original attachments (default true).'),
    fromAddress,
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict();
export type EmailForwardInput = z.infer<typeof emailForwardSchema>;

export const emailDraftSchema = z
  .object({
    draftId: z
      .string()
      .min(5)
      .max(80)
      .optional()
      .describe('Update this draft instead of creating one.'),
    to: recipientList.optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    subject: z.string().max(998).optional(),
    ...body,
    replyToMessageId: messageId.optional().describe('Start the draft as a reply to this message.'),
    replyAll: z.boolean().optional(),
    fromAddress,
  })
  .strict();
export type EmailDraftInput = z.infer<typeof emailDraftSchema>;

export const emailDraftSendSchema = z.object({ draftId: z.string().min(5).max(80) }).strict();

export const emailMoveSchema = z
  .object({ messageId, folder: z.enum(['inbox', 'spam', 'archive', 'trash']) })
  .strict();

export const emailMarkSchema = z
  .object({ messageId, seen: z.boolean().optional(), flagged: z.boolean().optional() })
  .strict();

export const emailDeleteSchema = z.object({ messageId }).strict();

export const emailAuditSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(4096).optional(),
  })
  .strict();
