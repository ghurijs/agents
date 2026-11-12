// @ghuri/agents — AI agents whose tools are your models, viewsets and permissions; plus an MCP server.
// See ARCHITECTURE.md §10 (github.com/ghurijs/ghuri). Workers-safe: provider packages load lazily.

export {
  Agent,
  type AgentInput,
  type AgentRunContext,
  type AgentRunResult,
  AgentStream,
  type RunOptions,
  type ToolCallInfo,
  type ToolCallRecord,
  type ToolEntry,
  type ToolsInput,
} from './agent'
export { AgentsConfig } from './apps'
export { AgentError, ModelResolutionError, ToolError, ToolInputError, UnknownToolError } from './errors'
export {
  AgentChatView,
  type AgentClass,
  AgentRouter,
  type AgentRouterOptions,
  agentAuthenticationClasses,
  ConversationDetailView,
  ConversationListView,
  ModelUnavailable,
} from './http'
export {
  type AgentSource,
  agentTool,
  isModernProtocolVersion,
  JSONRPC,
  type JsonRpcId,
  type JsonRpcResponse,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_META,
  MCP_MODERN_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSIONS,
  type McpCallContext,
  McpError,
  McpServer,
  type McpServerOptions,
  McpView,
  mcpWellKnownUrls,
} from './mcp'
export {
  ConversationNotFound,
  createConversation,
  getConversation,
  loadMessages,
  memoryAvailable,
  saveMessages,
} from './memory'
export { Conversation, MESSAGE_ROLES, Message, type MessageRole } from './models'
export {
  bearerChallenge,
  canonicalResourceUrl,
  expandScopes,
  InsufficientScope,
  type McpOAuthOptions,
  type McpTokenInfo,
  type McpTokenVerifier,
  mcpResource,
  missingScopes,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  requireScopes,
} from './oauth'
export {
  getProviders,
  isLanguageModel,
  type ProviderContext,
  type ProviderFactory,
  registerProvider,
  resolveModel,
  unregisterProvider,
} from './providers'
export {
  AGENT_JOB_TYPE,
  type AgentJob,
  consumeAgentQueue,
  type EnqueueOptions,
  enqueueRun,
  loadJobUser,
} from './queue'
export { type AgentsSettings, agentsSettings, type ProviderConfig } from './settings'
export { runTool, toToolError } from './tools/execute'
export { type ModelToolAction, ModelTools, type ModelToolsOptions } from './tools/model'
export { RouterTools, type RouterToolsOptions } from './tools/router'
export { sanitizeToolName, toJSONSchema } from './tools/schema'
export {
  collectDeclaredTools,
  defineTool,
  isToolDecorator,
  standaloneTool,
  TOOL,
  TOOL_OPTIONS,
  type ToolDecorator,
  type ToolOptions,
  tool,
} from './tools/tool'
export {
  type AgentTool,
  isAgentTool,
  isToolkit,
  type JSONSchema,
  type ToolAnnotations,
  type ToolContext,
  Toolkit,
} from './tools/types'
export {
  type ActionToolSpec,
  scopesFor,
  type ToolScopes,
  ViewSetTools,
  type ViewSetToolsOptions,
} from './tools/viewset'
