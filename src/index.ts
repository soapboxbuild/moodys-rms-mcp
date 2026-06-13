import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

// Moody's RMS Climate on Demand
// Docs: https://developer.rms.com/climate-on-demand
// Auth: API key in Authorization header (no Bearer prefix)
// Host: tenant-specific — pass via X-RMS-Host header or RMS_HOST env var

const DEFAULT_HOST = process.env.RMS_HOST ?? "";

async function rmsFetch(apiKey: string, host: string, path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`https://${host}${path}`, {
    ...options,
    headers: { Authorization: apiKey, "Content-Type": "application/json", ...(options.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`Moody's RMS error ${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

const SCENARIOS = z.array(z.string()).optional().default(["RCP45", "RCP85"]).describe("Climate scenarios (RCP45, RCP85)");
const HORIZONS = z.array(z.number()).optional().default([2030, 2050]).describe("Projection years");

function createServer(apiKey: string, host: string): McpServer {
  const server = new McpServer({ name: "moodys-rms-climate-on-demand", version: "0.1.0" });

  server.tool("list_datasources", "List available Climate on Demand data sources and hazards licensed for this tenant. Call this first to discover available workflows.", {},
    async () => {
      const result = await rmsFetch(apiKey, host, "/riskmodelerv1/datasources");
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "analyze_real_assets",
    "Assess physical climate risk for real estate assets. Scores each asset across flood, heat stress, hurricane/typhoon, sea level rise, water stress, wildfire, and earthquake under multiple scenarios and time horizons. Aligned with TCFD, ISSB, IFRS S2, and CSRD physical risk disclosure.",
    {
      assets: z.array(z.object({
        id: z.string().describe("Unique asset identifier"),
        lat: z.number().describe("Latitude"),
        lon: z.number().describe("Longitude"),
        address: z.string().optional(),
        asset_class: z.string().optional().describe("e.g. office, retail, industrial, residential, multifamily"),
        value_usd: z.number().optional().describe("Asset value in USD"),
      })),
      scenarios: SCENARIOS,
      time_horizons: HORIZONS,
    },
    async ({ assets, scenarios, time_horizons }) => {
      const result = await rmsFetch(apiKey, host, "/riskmodelerv1/cod/realassets/analyze", {
        method: "POST",
        body: JSON.stringify({ assets, scenarios, time_horizons }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "analyze_corporates",
    "Assess physical climate risk at company and facility level. Returns aggregated corporate exposure and per-facility hazard scores. Used for TCFD corporate disclosures and supply chain risk.",
    {
      companies: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
        facilities: z.array(z.object({ lat: z.number(), lon: z.number(), name: z.string().optional() })),
      })),
      scenarios: SCENARIOS,
      time_horizons: HORIZONS,
    },
    async ({ companies, scenarios, time_horizons }) => {
      const result = await rmsFetch(apiKey, host, "/riskmodelerv1/cod/corporates/analyze", {
        method: "POST",
        body: JSON.stringify({ companies, scenarios, time_horizons }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_hazard_scores",
    "Get raw physical hazard scores for a lat/lon point across all licensed perils and scenarios.",
    { lat: z.number(), lon: z.number(), scenarios: SCENARIOS, time_horizons: HORIZONS },
    async ({ lat, lon, scenarios, time_horizons }) => {
      const result = await rmsFetch(apiKey, host, "/riskmodelerv1/cod/hazards/scores", {
        method: "POST",
        body: JSON.stringify({ lat, lon, scenarios, time_horizons }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("get_job_status", "Poll status of an async analysis job.",
    { job_id: z.string() },
    async ({ job_id }) => {
      const result = await rmsFetch(apiKey, host, `/riskmodelerv1/cod/jobs/${job_id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("get_job_results", "Retrieve results of a completed analysis job.",
    { job_id: z.string() },
    async ({ job_id }) => {
      const result = await rmsFetch(apiKey, host, `/riskmodelerv1/cod/jobs/${job_id}/results`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

const app = new Hono();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "X-RMS-Host", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"], exposeHeaders: ["mcp-session-id", "mcp-protocol-version"] }));
app.get("/health", (c) => c.json({ status: "ok", service: "moodys-rms-mcp" }));

app.all("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization") ?? c.req.header("authorization") ?? "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
  const host = c.req.header("X-RMS-Host") ?? c.req.header("x-rms-host") ?? DEFAULT_HOST;
  if (!apiKey) return c.json({ error: "Authorization header required (your RMS API key)" }, 401);
  if (!host) return c.json({ error: "X-RMS-Host header required (your RMS tenant hostname, e.g. api-tenant.rms.com)" }, 400);
  const server = createServer(apiKey, host);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
serve({ fetch: app.fetch, port: PORT }, () => console.log(`moodys-rms-mcp running on port ${PORT}`));
