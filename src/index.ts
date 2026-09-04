export { SynomemClient, SynomemCore } from './client.js';
export type { SynomemCoreOptions } from './client.js';
export type { ProjectionWriter } from './ports/projections.js';
export type { SynomemRepository } from './ports/repository.js';
export {
  configuredServiceFactory,
  createConfiguredService,
  readSynomemConfig,
  writeSynomemBackend,
} from './backend.js';
export { RemoteSynomemService, environmentCredentialProvider } from './remote.js';
export type { SynomemCredentialProvider, RemoteSynomemOptions } from './remote.js';
export { credentialReference, OsCredentialStore } from './credentials.js';
export type { CredentialStore, StoredOAuthCredential } from './credentials.js';
export { loginWithOAuth, StoredCredentialProvider } from './oauth.js';
export type { OAuthLoginOptions } from './oauth.js';
export {
  createLocalImportBundle,
  importBundleChecksum,
  RemoteImportClient,
  validateImportBundle,
} from './import.js';
export type {
  ImportBundle,
  ImportPreview,
  ImportResult,
  RemoteImportClientOptions,
} from './import.js';
export type {
  SynomemService,
  SynomemDomainService,
  SynomemServiceCapabilities,
  SynomemServiceFactory,
  SynomemServiceInfo,
  ProjectionRebuildResult,
} from './service.js';
export { defaultConfig, resolveHome } from './config.js';
export { asSynomemError, errorCodes, SynomemError } from './errors.js';
export { escapeMarkdown, recordsFromEvents, renderMarkdownExport } from './projections.js';
export {
  actorSchema,
  agentIdSchema,
  changesInputSchema,
  createAgentSchema,
  createNoteSchema,
  createTodoSchema,
  eventSchema,
  evidenceSchema,
  giveKudosSchema,
  giveKudosMcpSchema,
  itemListInputSchema,
  kudosTagSchema,
  kudosTitleSchema,
  listInputSchema,
  profileSchema,
  reviseNoteSchema,
  sendMemoSchema,
  updateTodoSchema,
  updateAgentSchema,
} from './schemas.js';
export type * from './types.js';
