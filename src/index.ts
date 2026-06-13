import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const BASE_URL = "https://api.arcadia.com/v1";

// EPA eGRID 2023 emission factors (lbs CO2/MWh)
const EGRID_FACTORS: Record<string, number> = {
  CA: 430,
  NY: 260,
  TX: 850,
  FL: 900,
  IL: 700,
  PA: 750,
  OH: 950,
  GA: 880,
  NC: 820,
  WA: 90,
  OR: 300,
  CO: 950,
  MA: 550,
  NJ: 470,
  VA: 700,
  MD: 620,
  MN: 730,
  WI: 940,
  MI: 850,
  AZ: 850,
};
const DEFAULT_EGRID_FACTOR = 850;

function createServer(authToken: string): McpServer {
  const server = new McpServer({
    name: "arcadia-mcp",
    version: "0.1.0",
  });

  async function arcadiaFetch(path: string): Promise<unknown> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: authToken,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Arcadia API error ${response.status}: ${text}`);
    }
    return response.json();
  }

  // 1. list_utility_accounts
  server.registerTool(
    "list_utility_accounts",
    {
      title: "List Utility Accounts",
      description:
        "List all connected utility accounts for the authenticated user",
      inputSchema: {},
    },
    async () => {
      const data = await arcadiaFetch("/plug/accounts");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 2. get_account
  server.registerTool(
    "get_account",
    {
      title: "Get Utility Account",
      description:
        "Get details for a specific utility account including meters and connection status",
      inputSchema: {
        accountId: z.string().describe("The utility account ID"),
      },
    },
    async ({ accountId }) => {
      const data = await arcadiaFetch(`/plug/accounts/${accountId}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 3. get_bills
  server.registerTool(
    "get_bills",
    {
      title: "Get Utility Bills",
      description: "Get utility bills (statements) for an account",
      inputSchema: {
        accountId: z.string().describe("The utility account ID"),
        startDate: z
          .string()
          .optional()
          .describe("Start date in YYYY-MM-DD format"),
        endDate: z
          .string()
          .optional()
          .describe("End date in YYYY-MM-DD format"),
        limit: z
          .number()
          .optional()
          .default(12)
          .describe("Maximum number of bills to return (default 12)"),
      },
    },
    async ({ accountId, startDate, endDate, limit = 12 }) => {
      const params = new URLSearchParams();
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      params.set("limit", String(limit));
      const query = params.toString();
      const data = await arcadiaFetch(
        `/plug/accounts/${accountId}/statements${query ? `?${query}` : ""}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 4. get_interval_data
  server.registerTool(
    "get_interval_data",
    {
      title: "Get Interval Data",
      description:
        "Get high-resolution interval consumption data for a specific meter",
      inputSchema: {
        meterId: z.string().describe("The meter ID"),
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
        granularity: z
          .enum(["15min", "30min", "hourly", "daily"])
          .optional()
          .default("daily")
          .describe(
            'Data granularity: "15min", "30min", "hourly", or "daily" (default "daily")'
          ),
      },
    },
    async ({ meterId, startDate, endDate, granularity = "daily" }) => {
      const params = new URLSearchParams({
        start: startDate,
        end: endDate,
        granularity,
      });
      const data = await arcadiaFetch(
        `/plug/normalizedIntervals/meters/${meterId}?${params.toString()}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 5. get_meters
  server.registerTool(
    "get_meters",
    {
      title: "Get Meters",
      description: "List all meters associated with a utility account",
      inputSchema: {
        accountId: z.string().describe("The utility account ID"),
      },
    },
    async ({ accountId }) => {
      const data = await arcadiaFetch(`/plug/accounts/${accountId}/meters`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 6. calculate_carbon
  server.registerTool(
    "calculate_carbon",
    {
      title: "Calculate Carbon Emissions",
      description:
        "Calculate carbon emissions from electricity usage using EPA eGRID 2023 emission factors",
      inputSchema: {
        kwh: z.number().describe("Electricity consumption in kilowatt-hours"),
        state: z
          .string()
          .length(2)
          .describe("2-letter US state code (e.g. CA, NY, TX)"),
        year: z.number().optional().describe("Year (optional, informational)"),
      },
    },
    async ({ kwh, state, year }) => {
      const stateUpper = state.toUpperCase();
      const emissionFactor =
        EGRID_FACTORS[stateUpper] ?? DEFAULT_EGRID_FACTOR;
      // Convert: factor is lbs/MWh, input is kWh
      const lbsCO2 = (kwh / 1000) * emissionFactor;
      const kgCO2e = lbsCO2 * 0.453592;

      const result = {
        kwh,
        state: stateUpper,
        year: year ?? null,
        kgCO2e: Math.round(kgCO2e * 1000) / 1000,
        lbsCO2: Math.round(lbsCO2 * 1000) / 1000,
        emissionFactor,
        emissionFactorUnit: "lbs CO2/MWh",
        methodology: "EPA eGRID 2023",
        stateFound: stateUpper in EGRID_FACTORS,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

// Build Hono app
const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
);

app.get("/health", (c) => c.json({ status: "ok", service: "arcadia-mcp" }));

// Stateless MCP endpoint — create fresh server + transport per request
app.all("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  const server = createServer(authHeader);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`arcadia-mcp running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});
