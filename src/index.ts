export { SynomemClient, SynomemCore } from './client.js';
export type { SynomemCoreOptions } from './client.js';
export type { ProjectionWriter } from './ports/projections.js';
export type { SynomemRepository } from './ports/repository.js';
export { readSynomemConfig } from './backend.js';
export { RemoteSynomemService, environmentCredentialProvider } from './remote.js';
export type {
  RemoteCredential,
  RemoteCredentialSource,
  SynomemCredentialProvider,
  RemoteSynomemOptions,
} from './remote.js';
export { createLocalResolver, createRemoteResolver, localContextId } from './resolvers.js';
export type { ContextResolver, ResolvedContext } from './resolvers.js';
export { OsCredentialStore } from './credentials.js';
export type {
  CredentialStore,
  StoredAccessKey,
  StoredCredential,
  StoredOAuthCredential,
} from './credentials.js';
export { loginWithOAuth } from './oauth.js';
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
export { cloudApiUrl, SYNOMEM_CLOUD_API_URL } from './cloud.js';
export {
  DEFAULT_WORKSPACE,
  listLocalWorkspaces,
  localWorkspaceHome,
  WORKSPACES_DIRECTORY,
  workspaceNameSchema,
} from './workspaces.js';
export type { LocalWorkspace } from './workspaces.js';
export {
  findProjectSelection,
  PROJECT_CONFIG_FILE,
  PROJECT_DIRECTORY,
  projectConfigSchema,
  writeProjectSelection,
} from './project.js';
export type { ProjectConfig, ProjectSelection } from './project.js';
export {
  describeIdentity,
  discoverContexts,
  discoverOrganizations,
  workspaceChoices,
} from './discover.js';
export type { DiscoveredOrganization, DiscoveredWorkspace, DiscoveryOptions } from './discover.js';
export { asSynomemError, errorCodes, SynomemError } from './errors.js';
export {
  dueInstant,
  escapeMarkdown,
  recordsFromEvents,
  renderMarkdownExport,
} from './projections.js';
export {
  actorSchema,
  agentAliasSchema,
  agentIdSchema,
  agentLookupSchema,
  bindRuntimeSchema,
  changesInputSchema,
  createAgentSchema,
  createNoteSchema,
  createTaskSchema,
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
  updateTaskSchema,
  updateTodoSchema,
  updateAgentSchema,
  topicIdSchema,
  topicAliasSchema,
  topicNameSchema,
  topicLookupSchema,
  topicProfileSchema,
  createTopicSchema,
  updateTopicSchema,
  topicListInputSchema,
} from './schemas.js';
export type * from './types.js';
