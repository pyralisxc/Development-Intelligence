# ChatGPT publishing and cross-app acceptance

This runbook covers the final distribution path for using Development Intelligence from ChatGPT chats and Work sessions while preserving Development Intelligence as one standalone read-only technical-intelligence service.

## Target state

The intended path is:

`Git/source -> hosted Development Intelligence -> native OAuth MCP endpoint -> ChatGPT custom app -> chats / Work`

GitHub remains a separate ChatGPT app/tool. Development Intelligence does not proxy, wrap, or replace GitHub. Once the Development Intelligence app is available normally in ChatGPT, one prompt may use both apps when the ChatGPT surface/plan supports multi-app orchestration.

## What the repository now owns

Development Intelligence can host its own small single-owner OAuth front door with:

- RFC 9728 protected-resource metadata;
- OAuth authorization-server metadata;
- public-client dynamic registration;
- authorization-code flow with PKCE S256;
- explicit owner consent;
- short-lived bearer access tokens;
- refresh tokens that survive service restarts because they are signed rather than stored in a local database;
- an optional static `DEVINT_AGENT_TOKEN` fallback for trusted non-OAuth MCP clients.

OAuth is only an access boundary. It does not enter the graph model, accepted checkpoints, source authority, or project semantics.

## 1. Deploy a stable HTTPS service

The deployment must run the normal Development Intelligence Node process and provide a stable public HTTPS origin. Ephemeral pull-request Preview tunnels are useful for human review but are not appropriate for a durable ChatGPT connection.

Set at minimum:

```text
DEVINT_AUTH_MODE=oauth
DEVINT_OWNER_PASSWORD=<strong owner password>
DEVINT_SESSION_SECRET=<long random secret>
DEVINT_PUBLIC_BASE_URL=https://<stable-hostname>
DEVINT_PROJECTS_FILE=<deployment project registry path>
```

Recommended hosted values:

```text
DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com
DEVINT_OAUTH_SCOPES=development-intelligence.read
DEVINT_ALLOWED_HOSTS=<stable-hostname>
```

Keep secure cookies enabled. Do not set `DEVINT_COOKIE_SECURE=0` on HTTPS deployments.

Generate secrets outside Git, for example with a password manager or `openssl rand -hex 32`. Never commit owner passwords, session secrets, Git credentials, technical-source credentials, or bearer tokens.

`DEVINT_SESSION_SECRET` is also used to derive purpose-separated signing keys for OAuth client registrations and tokens. Rotating it invalidates browser sessions, OAuth access/refresh tokens, and dynamically registered client IDs.

## 2. Verify the hosted OAuth discovery surface

Before touching ChatGPT, verify these URLs on the final hostname:

```text
GET https://<host>/health
GET https://<host>/.well-known/oauth-protected-resource/mcp
GET https://<host>/.well-known/oauth-authorization-server
```

The protected-resource document must identify exactly:

```text
resource = https://<host>/mcp
authorization_servers = [https://<host>]
```

An unauthenticated `POST https://<host>/mcp` must return HTTP `401` with a `WWW-Authenticate` challenge that contains the protected-resource metadata URL.

## 3. Create or replace the ChatGPT custom app

Use ChatGPT on the web because custom MCP app creation and publishing controls may not be exposed on mobile.

Current OpenAI flow:

1. Open **Settings -> Apps -> Advanced settings** and enable **Developer mode** if your plan/workspace requires it.
2. Open **Settings -> Apps -> Create** (or the corresponding Workspace Settings path on a managed workspace).
3. Name the app **Development Intelligence**.
4. MCP server URL: `https://<host>/mcp`.
5. Authentication: **OAuth**.
6. Prefer automatic/dynamic client registration. Development Intelligence accepts public PKCE clients and restricts callback origins to `https://chatgpt.com` by default.
7. Choose **Scan Tools** and complete the browser authorization flow.
8. Sign in using the Development Intelligence owner password.
9. Review the consent page and approve only when the client/return host is the ChatGPT connection you initiated.
10. Finish creating the draft app.

If ChatGPT's current UI requires a user-defined OAuth client instead of dynamic registration, set these deployment variables first:

```text
DEVINT_OAUTH_CLIENT_ID=<the client id you enter in ChatGPT>
DEVINT_OAUTH_CLIENT_NAME=ChatGPT
DEVINT_OAUTH_REDIRECT_URIS=<the exact callback URL ChatGPT displays>
```

Then recreate/refresh the draft app. Do not guess the callback URL; copy the exact value displayed by ChatGPT.

## 4. Prove refresh continuity

A successful first login is not sufficient release evidence.

The authorization-server metadata advertises `offline_access`, and Development Intelligence issues refresh tokens. Verify that ChatGPT remains connected after the short access token expires or after reconnecting to a restarted Development Intelligence process.

If the OAuth connection was created before the hosted metadata changed, remove/recreate or reconnect the draft app so ChatGPT fetches the current OAuth metadata and credentials.

## 5. Prove Development Intelligence by itself

In a fresh chat, select or `@mention` Development Intelligence and ask it to perform read-only technical intelligence, for example:

```text
Use Development Intelligence to list the indexed projects and show the architecture overview for Development-Intelligence.
```

The call must reach the hosted service without a token-exchange error.

## 6. Prove Development Intelligence + GitHub in the same prompt

This is the release gate that distinguishes a usable ChatGPT integration from an isolated developer test.

With both Development Intelligence and GitHub available, use one message that genuinely requires both, for example:

```text
Use Development Intelligence to identify the architecture and affected symbols around OAuth authentication in Development-Intelligence, then use GitHub to inspect PR #4 and compare the changed files against that impact. Keep the two evidence sources distinct.
```

Then run the inverse direction:

```text
Use GitHub to inspect PR #4 first. From the changed files, use Development Intelligence to trace the architectural blast radius and report any affected public MCP contracts.
```

Acceptance requires both app/tool families to execute in the same conversation and, where the ChatGPT surface supports it, the same prompt. A Development Intelligence result copied manually into a separate GitHub-only conversation is not equivalent evidence.

## 7. Work-session acceptance

Open a new Work session and perform the same mixed-source task. Work must be able to call the installed/available Development Intelligence app and GitHub rather than requiring repository-local Development Intelligence setup.

Workspace Agents are a separate product control: the agent builder must explicitly enable Development Intelligence for an agent before that agent can use it. Instructions alone do not grant app access.

## 8. Publish in a managed workspace when available

On Business/Enterprise/Edu workspaces, keep the app as a draft until the OAuth and cross-app tests pass. Then an Admin/Owner can publish it from **Workspace settings -> Apps -> Drafts** and configure who may access it/actions as applicable.

Published custom apps use a reviewed/frozen tool snapshot. When Development Intelligence changes tool definitions later, refresh/review the app actions before expecting ChatGPT to use the new definitions.

On consumer/Pro surfaces, custom MCP availability and publication controls differ; keep Developer mode enabled where required and treat the connection as developer-mode until the product exposes a publish path for that account type.

## 9. Release evidence

Before merging a publishing/auth candidate, retain evidence for:

- exact Git candidate SHA;
- `npm run verify` green;
- CardForge benchmark green;
- OAuth metadata discovery from the final HTTPS hostname;
- successful owner authorization;
- successful MCP tool discovery/call;
- successful refresh/reconnect behavior;
- unauthorized MCP request fails closed;
- one Development Intelligence + GitHub mixed prompt;
- one fresh Work-session mixed task when Work is in release scope.

Only after those pass should the candidate be promoted/merged and tagged as the release intended for general ChatGPT use.

## Troubleshooting

### `OAuth token request failed`

Check, in order:

1. `DEVINT_PUBLIC_BASE_URL` exactly matches the externally reachable HTTPS origin.
2. `/.well-known/oauth-protected-resource/mcp` returns the final `/mcp` resource URL.
3. `/.well-known/oauth-authorization-server` returns the same origin as `issuer` and reachable `/oauth/authorize`, `/oauth/token`, and `/oauth/register` endpoints.
4. ChatGPT callback origin is permitted by `DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS`.
5. The authorization request uses PKCE `S256`.
6. The ChatGPT app was recreated/reconnected after metadata or hostname changes.
7. The deployment is not sleeping/restarting between authorization and the one-time authorization-code exchange.

### ChatGPT can use Development Intelligence but not GitHub in the same prompt

First distinguish a platform/tool-selection restriction from a Development Intelligence error. Published/current ChatGPT workspace apps are designed to support multi-app prompts, but availability depends on plan, surface, workspace controls, and whether the app is still only a developer-mode draft. Record the exact ChatGPT surface and app state before changing Development Intelligence.

### Changing the public hostname

Changing `DEVINT_PUBLIC_BASE_URL` changes the OAuth issuer/resource identity. Recreate or reconnect the ChatGPT app; do not expect credentials issued for the old origin to remain valid.
