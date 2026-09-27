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

1. **Base image**: `dhi.io/node:24-alpine3.23` instead of `node:24-trixie-slim`. DHI images are minimal by default - most are effectively distroless at runtime, meaning there's no shell, no package manager, and no incidental tooling sitting in the final image for an attacker to abuse if the container is ever compromised.
2. **Multi-stage build is mandatory in practice, not just best practice**: because the runtime image has no shell, you cannot `RUN npm ci` in the final stage the way you can on a normal image. Dependencies have to be installed in a build stage and copied into the runtime stage as plain files. This is the same pattern Docker's own [Node.js migration guide](https://docs.docker.com/dhi/migration/examples/node/) and [Backstage migration guide](https://docs.docker.com/guides/dhi-backstage/) document.

First authenticate (one-time, free account):

```bash
docker login dhi.io
```

Then build:

```bash
docker build -t hardened-demo-server:dhi -f Dockerfile.dhi .
```

> **Note on tags**: `24-alpine3.23` matches Docker's published examples at the time this repo was written. DHI tags are updated on Docker's own schedule as new Node.js/Alpine versions ship - check the [live DHI catalog](https://docs.docker.com/dhi/) for current tags before building, rather than assuming this one stays valid indefinitely.

### Comparing the two images

Run both of these yourself and record your own numbers - they'll change over time as both base images get patched, so don't take pre-written numbers from any article (including one based on this repo) as current:

```bash
# Image size
docker images hardened-demo-server --format "{{.Tag}}\t{{.Size}}"

# CVE comparison (requires Docker Scout, bundled with Docker Desktop)
docker scout cves hardened-demo-server:standard
docker scout cves hardened-demo-server:dhi
```

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

CI builds and smoke-tests the **standard** image only - it starts the container, waits for `/health`, and sends a real `initialize` call to `/mcp` over Streamable HTTP to confirm the server responds with a well-formed JSON-RPC message. It does not build `Dockerfile.dhi`, because that requires an authenticated `docker login dhi.io`, and this is a public demo repo where asking every fork/PR to carry Docker Hub credentials isn't a reasonable ask. Build and compare the DHI image locally using the steps above. Dockerfile syntax for both files is linted with `hadolint` on every push.

> **Note:** the CI workflow file (`.github/workflows/ci.yml`) isn't pushed yet - see the note in the repo's latest setup step for the file to add manually.

## Limitations of this repo

- The MCP server itself is a teaching aid (two trivial tools, no auth, no external calls) - not something to deploy as-is
- No Kubernetes manifests here; if you want the multi-user, always-on deployment story (Ingress, cert-manager, HPA), that's a separate concern from the base-image hardening this repo focuses on
- DHI tag names and exact CVE/size deltas will drift over time - treat the numbers you measure yourself as the source of truth, not any number written down in an article

## License

MIT
