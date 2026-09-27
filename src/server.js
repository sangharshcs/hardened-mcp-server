// Minimal MCP server exposing two deterministic, dependency-free tools.
//
// This server intentionally does no external I/O (no GitHub/Slack calls, no
// database) so that it builds and smoke-tests identically in CI regardless of
// network conditions. The point of this repo is the container/Docker story,
// not the MCP business logic - swap in your own tools for production use.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

function buildServer() {
  const server = new McpServer({
    name: "hardened-demo-server",
    version: "1.0.0",
  });

  server.tool(
    "word_count",
    "Count the words in a piece of text",
    { text: z.string().describe("Text to count words in") },
    async ({ text }) => {
      const count = text.trim().split(/\s+/).filter(Boolean).length;
      return { content: [{ type: "text", text: `${count} words` }] };
    }
  );

  server.tool(
    "server_time",
    "Return the current server time in UTC",
    {},
    async () => {
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Plain health endpoint for the Docker HEALTHCHECK and CI smoke test.
// Deliberately not part of the MCP protocol itself.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Stateless Streamable HTTP transport: a fresh McpServer + transport per
// request. Simpler than session-tracking for a demo server; see the MCP
// TypeScript SDK docs if you need stateful sessions for a real deployment.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());

  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
});
