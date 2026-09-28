# hardened-mcp-server

A minimal, real MCP server used to walk through one specific migration: taking a container from a standard base image to [Docker Hardened Images](https://docs.docker.com/dhi/) (DHI), then wiring it into the [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/) so it can be shared with an MCP client like Claude Desktop or Claude Code.

The MCP server itself is intentionally trivial (`word_count`, `server_time` - no external APIs, no secrets). The teaching content here is the container migration and the MCP Gateway wiring, not the business logic. Swap in your own tools for a real deployment.

## Why this exists

Docker made Hardened Images free and open source (Apache 2.0) in late 2025 / early 2026, and expanded the same hardening approach to MCP servers for services like MongoDB, Grafana, and GitHub. Docker's own documentation covers migrating applications in general (Go, Python, Node.js, .NET, Java) and covers their own pre-built MCP catalog servers - but there isn't yet a walkthrough of taking a **custom, internal MCP server** through the same hardening process. This repo is that walkthrough.

## Prerequisites

- Docker Desktop 4.48+ (for the MCP Toolkit) or Docker Engine + Compose
- A free [Docker ID](https://docs.docker.com/accounts/create-account/) - required even for the free tier of DHI, since pulling from `dhi.io` requires authentication
- Node.js 20+ only if you want to run the server outside a container

## Quickstart: run the standard image

```bash
git clone https://github.com/sangharshcs/hardened-mcp-server.git
cd hardened-mcp-server
docker build -t hardened-demo-server:standard -f Dockerfile .
docker run -d --name demo -p 3000:3000 hardened-demo-server:standard
curl http://localhost:3000/health
```

You should get `{"status":"ok"}`. This image is built from `node:24-trixie-slim` - a completely normal Node.js container, no hardening applied yet. This is the baseline everything below is compared against.

## The Docker Hardened Images migration

`Dockerfile.dhi` is the hardened version. Two differences from the standard `Dockerfile`:

1. **Base image**: `dhi.io/node:24-alpine3.23-dev` for the build stage, `dhi.io/node:24-alpine3.23` (no `-dev` suffix) for the runtime stage. This isn't optional - the plain tag has no shell at all, so `RUN npm ci` fails outright with `stat /bin/sh: no such file or directory` if you try to run it there. The `-dev` variant includes a shell and toolchain for exactly this reason; the runtime stage stays on the plain tag since it never needs a shell once the build artifacts are copied in.
2. **Multi-stage build is mandatory in practice, not just best practice**: because the runtime image has no shell, dependencies have to be installed in the `-dev` build stage and copied into the plain runtime stage as files. This is the same pattern Docker's own [Node.js migration guide](https://docs.docker.com/dhi/migration/examples/node/) and [Backstage migration guide](https://docs.docker.com/guides/dhi-backstage/) document.

First authenticate (one-time, free account):

```bash
docker login dhi.io
```

Then build:

```bash
docker build -t hardened-demo-server:dhi -f Dockerfile.dhi .
```

> **Note on tags**: tags above match Docker's published examples at the time this repo was written. DHI tags are updated on Docker's own schedule as new Node.js/Alpine versions ship - check the [live DHI catalog](https://docs.docker.com/dhi/) for current tags before building, rather than assuming these stay valid indefinitely.

### Comparing the two images: real numbers from this repo's own CI

CI builds both images and runs [Docker Scout](https://docs.docker.com/scout/) on every push where the `DOCKER_PAT` secret is configured. Here's an actual run: [build-and-scan-dhi, run #8](https://github.com/sangharshcs/hardened-mcp-server/actions/runs/36361828705/job/108740503469).

| | Standard (`node:24-trixie-slim`) | DHI (`dhi.io/node:24-alpine3.23`) |
|---|---|---|
| Image size | 104 MB | 56 MB (**-47 MB**) |
| Packages | 376 | 132 (**-244**) |
| Vulnerabilities | 0 Critical / 6 High / 6 Medium / 24 Low | 0 / 0 / 0 / 0 |

What actually got removed: the Debian userland the app never touches at runtime (`bash`, `systemd`, `login`/`passwd`/`shadow`, `pam`, `sysvinit`, `apt`, `dpkg`), plus - less obviously - the **entire npm CLI's own internal toolchain** (`@npmcli/*`, `pacote`, `npm-registry-fetch`, and dozens more) that ships inside `node:24-trixie-slim` by default, even though this server never invokes `npm` at runtime; it only ever runs `node src/server.js`.

These numbers will drift as both base images get repatched - re-run the workflow yourself (`Actions` tab -> `build-and-test` -> `Run workflow`) rather than trusting a number that ages relative to when this was written, including this one.

The DHI image also carries real, inspectable metadata confirming its hardening claims rather than asking you to take Docker's word for it:

```bash
docker inspect hardened-demo-server:dhi --format '{{json .Config.Labels}}'
```

Look for `com.docker.dhi.compliance=cis` and `com.docker.dhi.date.end-of-life=2028-04-30` - CIS-compliance and support-lifecycle claims as machine-readable OCI labels, not just marketing copy.

### What you lose, and how to get it back

Because the DHI runtime image has no shell, `docker exec -it <container> sh` will fail. This is intentional - it's the same hardening that removes a shell from an attacker who compromises the container. For debugging, use [Docker Debug](https://docs.docker.com/reference/cli/docker/debug/) instead, which attaches a debugging toolkit without adding one to the image itself.

If your own real server needs to compile native Node.js addons (e.g. `better-sqlite3`, `bcrypt`, `sharp`), your build stage will need extra packages the base DHI build stage doesn't include - see the [Backstage migration guide](https://docs.docker.com/guides/dhi-backstage/) for that specific pattern; this demo server has no native dependencies so it doesn't need it.

## Wiring into the Docker MCP Gateway

`docker-compose.yml` runs the hardened server alongside `docker/mcp-gateway`, which exposes it over SSE and lets any MCP client point at one URL instead of managing servers individually:

```bash
docker compose up -d --build
```

`catalog.yaml` describes the server in the format the Gateway's custom-catalog mechanism expects (see Docker's [Custom Catalogs and Profiles guide](https://www.docker.com/blog/create-custom-mcp-catalogs-and-profiles/) for the full mechanism). To register it:

```bash
docker mcp catalog create custom
docker mcp catalog add custom hardened-demo catalog.yaml
docker mcp server enable hardened-demo
```

Then point your MCP client at the Gateway, the same way you would for any Docker-managed server:

```json
{
  "mcpServers": {
    "MCP_DOCKER": {
      "command": "docker",
      "args": ["mcp", "gateway", "run"]
    }
  }
}
```

## What CI actually checks

Three jobs run on every push and pull request:

- **`lint-dockerfiles`** - lints both `Dockerfile` and `Dockerfile.dhi` with `hadolint`.
- **`build-and-smoke-test`** - builds the standard image, starts it, waits for `/health`, and sends a real `initialize` call to `/mcp` over Streamable HTTP to confirm the server responds with a well-formed JSON-RPC message. Runs unconditionally, no credentials needed.
- **`check-secrets`** + **`build-and-scan-dhi`** - builds `Dockerfile.dhi` (requires an authenticated `docker login dhi.io`) and runs Docker Scout to produce the size/CVE comparison above. Gated on whether the `DOCKER_PAT` repository secret is set: a `check-secrets` job resolves the secret through a step's `env:` and exposes the result as a job output, since GitHub Actions doesn't support referencing the `secrets` context directly inside a job-level `if:`. On forks or PRs from outside contributors where the secret isn't available, this job's steps show as skipped rather than failing.

## Limitations of this repo

- The MCP server itself is a teaching aid (two trivial tools, no auth, no external calls) - not something to deploy as-is
- No Kubernetes manifests here; if you want the multi-user, always-on deployment story (Ingress, cert-manager, HPA), that's a separate concern from the base-image hardening this repo focuses on
- DHI tag names and exact CVE/size deltas will drift over time - the numbers above are a snapshot from one CI run, not a permanent guarantee; re-run the workflow for current numbers

## License

MIT
