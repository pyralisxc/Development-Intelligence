# Development Intelligence orchestration

This file owns only **project-local execution policy** for Development Intelligence development. It does not own product meaning, graph semantics, architecture, deployment configuration, credentials, provider state, issue status, or accepted technical truth.

Use the existing owners for those concerns:

- `docs/product-direction.md` — product identity and direction.
- `docs/architecture.md` — graph/system semantics and technical boundaries.
- `docs/testing.md` — durable proof strategy and acceptance surfaces.
- `.github/workflows/verify.yml` — current CI, sealing, benchmark, and ephemeral preview implementation.
- `docs/operations.md` — runtime configuration, authentication, recovery, and operational boundaries.
- `docs/vercel-hosting.md` — Vercel-specific deployment mechanics.
- `docs/chatgpt-publishing.md` — hosted OAuth / ChatGPT release acceptance.
- GitHub and the hosting provider — current branch, check, deployment, and runtime state.

Do not copy volatile URLs, SHAs, secrets, deployment IDs, issue state, or provider state into this file.

## Execution states

### Accepted main

`main` is the accepted source branch. The accepted Development Intelligence checkpoint is whatever valid `/.development-intelligence/` state is committed with that exact Git revision.

A clean `main` must pass the repository's normal verification and accepted-checkpoint checks. Provider/runtime state is separate and must be read from the provider when current deployment fact matters.

### Work branch and pull request

Development changes belong on bounded `work/*` branches and PRs created from an exact accepted base revision.

The PR head is a proposal, not accepted truth. CI evidence applies only to the exact head SHA that produced it; after any source or checkpoint change, reevaluate the new head rather than carrying forward old green status.

### Sealed candidate B

Use the `seal-b` PR label when a candidate is ready for checkpoint sealing.

The repository workflow may generate and push a deterministic candidate B checkpoint onto the PR branch. That bot-generated seal commit changes the exact candidate SHA, so promotion requires a fresh verification pass on the **sealed head**, including packaged-action and benchmark gates.

A seal is not approval to merge. It only makes the candidate's accepted semantic projection reviewable and reproducible.

### Ephemeral PR preview

The hosted-preview workflow is opt-in and implemented by `.github/workflows/verify.yml`. It uses an isolated `devint-preview` ref/workspace derived from the exact PR head and exposes a temporary private-auth Development Intelligence instance through an ephemeral Cloudflare tunnel.

The preview is disposable review evidence:

- it is not a durable branch or graph authority;
- it is not accepted main;
- it is not the Vercel production runtime;
- temporary preview credentials and access records remain CI artifacts, not repository truth;
- preview implementation details belong in the workflow, not here.

Use the preview only when the PR intentionally requests the workflow's preview marker/path. Do not treat an ephemeral preview as a substitute for production-provider or OAuth acceptance.

### Hosted production runtime

The hosted runtime is deployed through Vercel. Vercel/provider state is authoritative for what is currently deployed.

Production acceptance that depends on OAuth, final hostname behavior, ChatGPT connectivity, or provider configuration must follow `docs/vercel-hosting.md`, `docs/operations.md`, and `docs/chatgpt-publishing.md`. Repository CI alone cannot prove provider-side or physical-client acceptance.

## Default development path

For a material change:

1. Read `AGENTS.md` and the owning product/architecture/operations docs for the change.
2. Start from the exact current `main` revision and create a bounded `work/*` branch.
3. Make the smallest coherent change; do not embed project-management state or provider secrets in source.
4. Run `npm run verify` and preserve any relevant permanent regression evidence.
5. Let PR CI run the repository's packaged action and permanent benchmark gates.
6. When a source-changing candidate is otherwise acceptable, request `seal-b`; then verify the exact sealed head again.
7. Use the ephemeral preview only when interactive hosted review is materially useful.
8. Promote to `main` only after the owner-approved merge gate is satisfied for the exact candidate.
9. When the change affects hosted behavior, complete the applicable Vercel/OAuth/ChatGPT acceptance after or around promotion as required by the owning release docs; do not infer provider success from GitHub alone.

## Ownership and issue routing

Development Intelligence may observe defects anywhere it has evidence, but development changes must follow the system that owns the defect.

- Fix Development Intelligence defects in this repository.
- If the evidence points to another repository or connected system, preserve the exact revision/check/provider evidence and route the problem to that owner instead of patching around it in Development Intelligence.
- Before creating an issue in another repository, inspect its active/upcoming work. Add evidence to an existing item when it already represents the problem; create a new issue only when the finding is materially useful and not already covered.
- If an external provider has no writable repository, record the provider-bound limitation or acceptance requirement in the nearest owning issue/docs rather than changing Development Intelligence semantics to hide it.
- Compatibility behavior belongs here only when Development Intelligence genuinely owns that compatibility boundary.

Development Intelligence has an additional portfolio-testing role: most repositories use DI to do their work, while DI intentionally examines representative repositories to test its own honesty, latency, evidence depth, and usefulness. Project-owned defects discovered during that testing are routed to the project; recurring DI-owned gaps become DI work with benchmark evidence.

## Evidence and uncertainty

GitHub checks, benchmark artifacts, exact Git identities, provider deployment state, and physical hosted-client tests are evidence. Keep them distinct.

Do not:

- treat a stale check from an earlier PR head as proof for a later head;
- treat a self-seal token-trigger quirk or skipped preview as a source-code failure without inspecting the exact check context;
- infer that production changed merely because `main` changed;
- infer that an ephemeral preview equals production;
- promote candidate or derived Development Intelligence conclusions into accepted graph truth without the normal checkpoint lifecycle.

When CI/provider state is ambiguous, inspect the exact PR head, exact base, individual check results, and provider state before changing code.

## Consequential gates

The following remain human/owner consequential decisions:

- merging/promoting a PR into accepted `main`;
- changing production hosting, OAuth identity, public hostname, credentials, or provider access;
- publishing/replacing the hosted ChatGPT app;
- broadening repository/runtime/source access;
- changing product or architecture authority.

Agents may prepare and verify candidates, but must not treat successful CI, a seal, or a preview as implicit authorization for those actions.
