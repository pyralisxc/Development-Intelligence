# Vercel hosting for Development Intelligence

Development Intelligence is intended to run on Vercel for the ChatGPT publishing path.

Vercel can run the repository as a Node/container-backed Vercel Function. The DI workload is compatible with that model because Git checkouts, structural graphs, and caches are disposable. The only cross-request state required by OAuth is the short-lived one-time authorization code, which DI stores in a shared Redis backing service when deployed on Vercel.

## Why Redis is required on Vercel

Vercel container instances are stateless and may scale down or route a later request to a different instance. OAuth authorization and token exchange are separate HTTP requests, so keeping authorization codes only in process memory would make token exchange unreliable and would break one-time code semantics.

DI therefore uses:

- signed/stateless dynamic client IDs;
- signed/stateless access tokens;
- signed/stateless refresh tokens;
- Redis only for five-minute one-time authorization codes, consumed atomically with `GETDEL`.

Redis is an operational auth backing service, not graph authority or project intelligence storage.

Local development and long-running single-instance hosts continue to use the in-memory code store unless shared state is explicitly required.

## Current deployment shape

The production service is deployed from `pyralisxc/Development-Intelligence` through the Vercel project owned by `Pyralis' projects` (`pyralis-projects`). Production follows `main`; feature branches are validated through preview deployments rather than being added to the production project registry.

For a clean replacement deployment, keep the currently reachable production environment intact until the replacement is deployed, reachable, and independently verified.

## 1. Create or reconnect the Vercel project

If the existing project must be recreated:

1. Import `pyralisxc/Development-Intelligence` from GitHub.
2. Use the `development-intelligence` project identity unless intentionally replacing it.
3. Keep the production branch on `main`.
4. Deploy feature branches as preview candidates.
5. Use `Dockerfile.vercel`; do not select an unrelated frontend framework preset.
6. Preserve the stable production/custom hostname during replacement and cut over only after hosted verification.

Repository scans are synchronous today. Treat observed request-duration or memory failures as scaling evidence for the planned asynchronous/content-addressed compute plane; do not hide them with partial results.

## 2. Add Upstash for Redis

In the Vercel project:

1. Open **Storage / Marketplace**.
2. Add **Upstash for Redis** to the Development Intelligence project.
3. A small/free database is sufficient for initial acceptance because DI stores only short-lived authorization codes.
4. Confirm the project receives:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

DI also accepts the older Vercel aliases `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

Do not paste these credentials into GitHub or ChatGPT messages.

## 3. Configure Development Intelligence environment variables

Set these for the Vercel deployment:

```text
DEVINT_AUTH_MODE=oauth
DEVINT_OWNER_PASSWORD=<strong password you choose>
DEVINT_SESSION_SECRET=<long random secret>
DEVINT_PUBLIC_BASE_URL=https://<stable-vercel-hostname>
DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com
DEVINT_OAUTH_SCOPES=development-intelligence.read
DEVINT_ALLOWED_HOSTS=<stable-vercel-hostname without https://>
DEVINT_REQUIRE_SHARED_OAUTH_STATE=1
```

Vercel automatically sets `VERCEL`, so DI will also reject OAuth configuration there when the shared Redis state is missing.

Keep secure cookies enabled. Do not set `DEVINT_COOKIE_SECURE=0` in Vercel.

### Project registry

Use `DEVINT_PROJECTS_JSON` so Vercel does not need a mounted `/config/projects.json` file.

```json
{
  "Development-Intelligence": {
    "repository": "https://github.com/pyralisxc/Development-Intelligence.git",
    "defaultRef": "refs/heads/main",
    "allowedRefs": ["refs/heads/main"],
    "revisionPolicy": "repository-history",
    "credential": {
      "type": "token-env",
      "tokenEnv": "DEVINT_GITHUB_TOKEN",
      "username": "x-access-token"
    }
  }
}
```

Store the compact JSON as the `DEVINT_PROJECTS_JSON` environment value.

Also add:

```text
DEVINT_GITHUB_TOKEN=<read-only GitHub credential>
DEVINT_GITHUB_ALLOWED_OWNERS=pyralisxc
DEVINT_GITHUB_TOKEN_ENV=DEVINT_GITHUB_TOKEN
```

The fixed registry keeps explicit configuration for Development Intelligence itself. The owner policy additionally lets callers inspect any repository under `pyralisxc` by using the project identifier `pyralisxc/<repository>`. Dynamic projects default to `HEAD` and support typed historical commit/branch/tag/PR selectors while remaining free of project-specific semantics, runtime origins, or technical-source configuration.

For a private repository, the credential must be able to read the repositories DI inspects. Prefer a fine-grained read-only credential limited to the repositories the service should reach. Development Intelligence does not require GitHub write access. Owner policy and token reach are independent: both must permit access.

## 4. Stable hostname bootstrap

The first deployment will normally receive a Vercel hostname before `DEVINT_PUBLIC_BASE_URL` is known.

1. Deploy once with the other variables configured.
2. Copy the stable production hostname Vercel assigns (for example `development-intelligence.vercel.app`; use the actual value).
3. Set `DEVINT_PUBLIC_BASE_URL` to `https://<that-hostname>`.
4. Set `DEVINT_ALLOWED_HOSTS` to the hostname only.
5. Redeploy.

Changing the public hostname later changes OAuth issuer/resource identity and requires reconnecting the ChatGPT app.

## 5. Hosted checks

Before configuring ChatGPT, verify:

```text
GET https://<host>/health
GET https://<host>/.well-known/oauth-protected-resource/mcp
GET https://<host>/.well-known/oauth-authorization-server
```

The protected resource must identify exactly `https://<host>/mcp` and the authorization server must be exactly `https://<host>`.

An unauthenticated `POST /mcp` must fail with `401` and advertise the OAuth protected-resource metadata.

## 6. Connect ChatGPT

Then follow `docs/chatgpt-publishing.md`:

1. ChatGPT web -> **Settings -> Apps -> Advanced settings** -> enable Developer mode if required.
2. **Settings -> Apps -> Create**.
3. Name: **Development Intelligence**.
4. MCP URL: `https://<host>/mcp`.
5. Authentication: **OAuth**.
6. Scan tools.
7. Complete DI owner sign-in and approve the ChatGPT client consent page.
8. Prove DI alone from a fresh chat.
9. Prove DI + GitHub in one mixed prompt.
10. Repeat from a fresh Work session when Work is in release scope.

Do not promote a candidate until these hosted acceptance checks pass.

## 7. Release and production acceptance

After preview and ChatGPT acceptance:

1. merge through normal review;
2. wait for the `main` production deployment;
3. verify health, OAuth discovery, owner Workbench access, and authenticated MCP tool discovery;
4. run one exact historical selector resolution and one distant revision comparison;
5. verify a mixed Development Intelligence + GitHub prompt against production;
6. create the intended Git tag/GitHub Release only after the deployed revision matches `main`.
