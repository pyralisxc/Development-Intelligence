# Vercel hosting for Development Intelligence

> **Deployment ownership:** this Vercel project hosts the Development Intelligence evidence service and its specialist Workbench. AI Systems Control is the canonical integrated owner website and must use a separate Vercel project in the same Vercel team. Do not repurpose the Development Intelligence deployment as the ASC frontend.

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

The production service is deployed from `pyralisxc/Development-Intelligence` through the Vercel project owned by `Pyralis' projects` (`pyralis-projects`). Production follows `main`; accumulated integration follows the persistent `preview` branch, and bounded work branches may produce shorter-lived preview deployments. None of those non-production branches are added to the production project registry.

For a clean replacement deployment, keep the currently reachable production environment intact until the replacement is deployed, reachable, and independently verified.

## 1. Create or reconnect the Vercel project

If the existing project must be recreated:

1. Import `pyralisxc/Development-Intelligence` from GitHub.
2. Use the `development-intelligence` project identity unless intentionally replacing it.
3. Keep the production branch on `main`.
4. Deploy `preview` and bounded work branches as preview candidates.
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
When `VERCEL=1`, DI adds Vercel's exact injected `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL` hostnames to the explicit host allowlist. In Vercel's `preview` environment, OAuth discovery uses the exact branch URL (or deployment URL when no branch URL exists); production continues to use `DEVINT_PUBLIC_BASE_URL`. This keeps preview URLs independently testable without trusting a `*.vercel.app` wildcard or changing production OAuth identity.

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

The shared hosted registry intentionally keeps `main` as the configured default. On the persistent Preview deployment, inspect the accumulated candidate with the explicit `branch:preview` revision selector. This avoids duplicating provider configuration or weakening production's default identity while still proving the Preview branch against its own exact source.

Also add:

```text
DEVINT_GITHUB_ALLOWED_OWNERS=pyralisxc

# Preferred: dedicated Development Intelligence GitHub App.
DEVINT_GITHUB_APP_ID=<app id>
DEVINT_GITHUB_APP_PRIVATE_KEY=<private key PEM>

# Optional token fallback when the App is not configured.
DEVINT_GITHUB_TOKEN=<read-only GitHub credential>
DEVINT_GITHUB_TOKEN_ENV=DEVINT_GITHUB_TOKEN
```

The fixed registry keeps explicit configuration for Development Intelligence itself. The owner policy additionally lets callers inspect any repository under `pyralisxc` by using the project identifier `pyralisxc/<repository>`. Dynamic projects default to `HEAD` and support typed historical commit/branch/tag/PR selectors while remaining free of project-specific semantics, runtime origins, or technical-source configuration.

For private repositories, prefer a dedicated Development Intelligence GitHub App installed on the repositories DI may inspect. Grant only **Contents: Read-only** and **Pull requests: Read-only** (GitHub provides Metadata read access automatically). DI mints a short-lived token restricted to the requested repository and fails if GitHub returns any non-read permission. The static token remains a fallback only.

Development Intelligence never requires GitHub write access. Owner policy and credential reach are independent: both must permit access.

## 4. Stable hostname bootstrap

The first deployment will normally receive a Vercel hostname before `DEVINT_PUBLIC_BASE_URL` is known.

1. Deploy once with the other variables configured.
2. Copy the stable production hostname Vercel assigns (for example `development-intelligence.vercel.app`; use the actual value).
3. Set `DEVINT_PUBLIC_BASE_URL` to `https://<that-hostname>`.
4. Set `DEVINT_ALLOWED_HOSTS` to the hostname only.
5. Redeploy.

Keep the stable hostname explicit even though Vercel's injected exact deployment hostnames are accepted automatically. Non-Vercel environments never trust those variables.

Changing the public hostname later changes OAuth issuer/resource identity and requires reconnecting the ChatGPT app.

## 5. Hosted checks

Before configuring ChatGPT, verify:

```text
GET https://<host>/health
GET https://<host>/.well-known/oauth-protected-resource/mcp
GET https://<host>/.well-known/oauth-authorization-server
```

`/health` reports the exact deployed Git revision when the platform supplies it, plus the MCP tool count and deterministic contract fingerprint. Vercel supplies `VERCEL_GIT_COMMIT_SHA`; custom deployment systems can set `DEVINT_BUILD_SHA` to an exact 40-character SHA. Values that do not match the allowlisted formats are reported as `null`.

Compare a hosted candidate with the built checkout:

```bash
npm run build
npm run verify:hosted -- --base-url https://<host> --expected-sha <40-character-sha>
```

For full authenticated MCP discovery, provide a short-lived bearer access token through `DEVINT_HOSTED_ACCESS_TOKEN` and add `--require-authenticated-tools`. Keep the token out of command history and logs. The `main` workflow polls the stable production host and fails if the deployed revision or public MCP contract remains stale.

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

## 8. Container registry retention

Deployment retention and Vercel Container Registry inventory are separate provider surfaces. Use the VCR image API to measure and clean registry headroom even when deployment retention is already configured.

The repository policy keeps:

- the current READY production deployment and one useful READY production rollback;
- production references for seven days;
- preview and other nonproduction references for one day;
- images with protected production tags;
- old images with unknown tags in manual review rather than deleting them automatically.

Run the supported inventory and cleanup planner with a scoped Vercel token:

```bash
export VERCEL_TOKEN=<scoped-token>
export VERCEL_PROJECT_ID=<project-id>
export VERCEL_TEAM_ID=<team-id>
npm run vcr:plan -- --repository dockerfile
```

The default is a dry run. It prints every image ID, digest, tag, age, decision, reason, and registry headroom before and after planned deletions. Review all `delete` and `review` entries before applying.

Apply the exact printed plan only by repeating the project ID as the confirmation value:

```bash
npm run vcr:plan -- --repository dockerfile --apply "$VERCEL_PROJECT_ID"
```

The apply path deletes only entries classified `delete`, one at a time, through Vercel's VCR image endpoint. Re-run the dry run after cleanup and confirm enough headroom exists before triggering another container deployment.
