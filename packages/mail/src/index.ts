export * from "./types.js";
export { getProvider, registerProvider, supportedProtocols } from "./providers/index.js";
export { imapProvider } from "./providers/imap.js";
export { pop3Provider, Pop3Client } from "./providers/pop3.js";
export { mockProvider, mockMailServer } from "./providers/mock.js";
export {
  createMailbox,
  getMailbox,
  listMailboxes,
  deleteMailbox,
  listDueMailboxes,
  mailboxConnection,
  setMailboxStatus,
  storeFetchResult,
  type Mailbox,
  type NewMailbox,
} from "./store.js";
export {
  syncMailbox,
  JOB_MAILBOX_SYNC,
  JOB_EMAIL_PROCESS,
  type SyncOutcome,
} from "./sync.js";
export {
  OAUTH_PROVIDERS,
  buildAuthUrl,
  exchangeCode,
  refreshTokens,
  signOAuthState,
  verifyOAuthState,
  OAuthError,
  type OAuthProviderDef,
  type OAuthTokens,
  type TokenResponse,
} from "./oauth.js";
export {
  enabledOAuthProviders,
  registerOAuthProviders,
  type EnabledOAuthProvider,
} from "./oauth-register.js";
export { createOAuthImapProvider } from "./providers/oauth-imap.js";
