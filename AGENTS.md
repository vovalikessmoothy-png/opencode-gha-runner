# Repository instructions

## Sandbox-Driven Engineering

Stopping before a safe development test, or refusing to test because a dev/test/staging run might fail, is harmful engineering behavior. In isolated local/dev/test/staging resources, deploy, run realistic inputs, inspect output/logs/state, diagnose failures, fix, and repeat. A sandbox failure is evidence to use. Do not ask again for permission for routine operations this contract allows.

Production and shared external state are separate protected boundaries. Sandbox autonomy never authorizes dispatching a job that can write to a user or production repository, or changing the shared Gateway, GitHub credentials, KV namespace, or deployed Worker. Follow the verified promotion path and preserve the requested task's scope.

## Environment Contract

This repository is the gateway and GitHub Actions worker for `opencode-gha-runner`. Read this contract and the specific workflow/source before operating a remote environment.

### Environments and endpoints

- **Local development/test:** Node.js 20+, `npm ci`, `npm run verify`; `npm run dev` starts the local gateway at `http://127.0.0.1:8787`. `npm run smoke` exercises launch → poll → claim → result → cancel over real local HTTP with a fake GitHub client. It does not contact GitHub, Cloudflare, GCS, or a VM.
- **Shared remote gateway:** `opencode-gha-runner-gateway` at `https://opencode-gha-runner-gateway.skillset-apply.workers.dev`, configured by the root `wrangler.toml` and its `RUNS` KV namespace. `GET /healthz` is a read-only liveness check. It reports configured dispatcher metadata; it does not prove a successful dispatch or execute a job.
- **GitHub Actions execution:** `.github/workflows/run-agent.yml` runs only after a remote `POST /v1/launch` or a manual workflow dispatch. The gateway's `GITHUB_REPO` is `vovalikessmoothy-png/opencode-gha-runner`; run output may create a branch and commit in the repository named by `repository.fullName`. Check the Actions run, authenticated `GET /v1/runs/{runId}`, commit/branch, and uploaded artifacts for results. Logs are attached to the Actions run; the documented local mode is `LOG_UPLOAD=local`.
- **Production:** no separate production Worker, staging Worker, isolated KV namespace, or installed VM worker is declared in this repository. The configured Gateway is shared and its credentials are real. Treat remote job dispatch and `npm run deploy` as protected shared-state operations until an isolated environment is established.

### Safe test procedure and reset

1. For routine feature work, run `npm ci && npm run verify`. For manual request/response debugging, run `npm run dev` and use the local HTTP endpoint with synthetic credentials/data; the smoke script is the canonical realistic input.
2. Remote `GET /healthz` is safe and read-only. Inspect GitHub Actions and existing run records read-only when authorized.
3. Do not call the shared remote `POST /v1/launch`, dispatch `run-agent.yml`, submit an arbitrary `repository.fullName`, or deploy the shared Worker as a routine test. Those actions dispatch real jobs and can write commits to an external repository. The existing config does not provide a disposable target, scoped test token, isolated Gateway/KV, or per-run cleanup.
4. Local scenarios reset by process restart; smoke uses synthetic in-memory state. Remote run state expires according to `RUN_TTL_SECONDS`; GitHub branches/commits and Actions runs are not rolled back by that TTL.

### Agent permissions and promotion

- Agents may edit this checkout, run local build/typecheck/tests/smoke, use read-only remote health/status/log inspection, and create task branches/PRs under repository policy.
- Agents may not read or disclose secret values; mutate shared Cloudflare/GitHub/GCS state; launch jobs against user/production repositories; or deploy the shared Worker under this contract.
- A remote end-to-end test requires a separately configured Gateway/KV and credentials scoped to a disposable test repository/branch, with an explicit cleanup/reset path. Until then this is a **Sandbox Gap**, tracked in [issue #26](https://github.com/vovalikessmoothy-png/opencode-gha-runner/issues/26), with the cross-project parent [trained-agent-architecture#182](https://github.com/trained-assist/trained-agent-architecture/issues/182) and rollout [#185](https://github.com/trained-assist/trained-agent-architecture/issues/185).
- No automated production promotion is declared here. Do not infer that merging or a successful local test deploys production. Any future promotion must name its owner, target, approvals, and rollback procedure.

When changing runtime behavior, create or update this contract and its sandbox before claiming the component is end-to-end testable. If a safe sandbox path is missing, fix a small gap in the task; otherwise document the evidence gap and create/link an owning issue.
