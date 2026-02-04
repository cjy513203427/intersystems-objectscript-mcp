import "dotenv/config";

import axios from "axios";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const EnvSchema = z.object({
  IRIS_URL: z
    .string()
    .min(1, "IRIS_URL is required")
    .default("http://localhost:63668"),
  IRIS_NAMESPACE: z.string().min(1).default("KELVIN"),
  IRIS_USERNAME: z.string().min(1, "IRIS_USERNAME is required").default("_SYSTEM"),
  IRIS_PASSWORD: z.string().min(1, "IRIS_PASSWORD is required").default("SYS"),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logs must go to stderr in stdio mode to avoid corrupting the protocol stream.
    console.error("环境变量校验失败：");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

function normalizeBaseUrl(url: string): string {
  // Remove trailing slashes to avoid accidental double-slashes when joining paths.
  return url.replace(/\/+$/, "");
}

function createIrisClient(env: Env) {
  return axios.create({
    baseURL: normalizeBaseUrl(env.IRIS_URL),
    auth: {
      username: env.IRIS_USERNAME,
      password: env.IRIS_PASSWORD,
    },
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });
}

function extractVersionInfo(data: unknown): string {
  if (data == null) return "No response body.";
  if (typeof data === "object") {
    try {
      const json = JSON.stringify(data);
      // Best-effort: some endpoints may include version-like fields.
      const m =
        /"version"\s*:\s*"([^"]+)"/i.exec(json) ??
        /"irisVersion"\s*:\s*"([^"]+)"/i.exec(json) ??
        /"productVersion"\s*:\s*"([^"]+)"/i.exec(json);
      if (m?.[1]) return `version=${m[1]}`;
      return JSON.stringify(data, null, 2).slice(0, 400);
    } catch {
      return "Received non-serializable object body.";
    }
  }
  if (typeof data === "string") {
    // If response is HTML/text, print a short snippet.
    const snippet = data.replace(/\s+/g, " ").slice(0, 400);
    return snippet.length > 0 ? snippet : "Empty string body.";
  }
  return String(data);
}

async function verifyConnection(env: Env): Promise<void> {
  const client = createIrisClient(env);

  try {
    // user_story.md step2 expects /api/atelier/ as the first HTTP link.
    const res = await client.get("/api/atelier/");
    console.error("IRIS 连接成功。");
    console.error(`HTTP ${res.status}`);
    console.error(`Atelier info: ${extractVersionInfo(res.data)}`);
  } catch (err: unknown) {
    console.error("IRIS 连接失败。");
    if (axios.isAxiosError(err)) {
      if (err.response) {
        console.error(`HTTP ${err.response.status}`);
        console.error(extractVersionInfo(err.response.data));
      } else {
        // Provide more details for network/TLS/DNS errors.
        console.error(`Request URL: ${err.config?.baseURL ?? ""}${err.config?.url ?? ""}`);
        if (err.code) console.error(`Error code: ${err.code}`);
        console.error(err.message);
      }
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const env = parseEnv();
  const verifyOnly = process.argv.includes("--verify-only");

  await verifyConnection(env);
  if (verifyOnly) return;

  const server = new McpServer({
    name: "intersystems-objectscript-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      description: "Health check for MCP connectivity.",
      inputSchema: z.object({}),
    },
    async () => {
      return {
        content: [{ type: "text", text: "pong" }],
      };
    },
  );

  server.registerTool(
    "get_iris_routine",
    {
      description:
        "Read-only: fetch compiled routine (.int) content from IRIS. Does not modify any code.",
      inputSchema: z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ name, namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      const routineName = name.endsWith(".cls") ? name.replace(/\.cls$/, ".1.int") : name;
      const client = createIrisClient(env);

      try {
        const res = await client.get(
          `/api/atelier/v1/${encodeURIComponent(resolvedNamespace)}/doc/${encodeURIComponent(
            routineName,
          )}`,
        );
        // Atelier doc responses are typically { result: { name, cat, content: string[] } }.
        const result = res.data?.result ?? res.data;
        const lines = Array.isArray(result?.content) ? result.content : null;
        const header = `[IRIS routine] name=${String(result?.name ?? routineName)} cat=${String(
          result?.cat ?? "unknown",
        )}`;
        const content = lines ? `${header}\n${lines.join("\n")}` : `${header}\n${extractVersionInfo(res.data)}`;
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          return {
            content: [
              {
                type: "text",
                text: "未找到对应的 routine 文档（例如 .1.int）。请确认类已编译且该 namespace 下存在生成的 .1.int。",
              },
            ],
          };
        }
        const details = axios.isAxiosError(err)
          ? err.message
          : String(err);
        return {
          content: [{ type: "text", text: `获取失败：${details}` }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Important: use stderr for logs in stdio transport.
  console.error("MCP server started (stdio).");
}

main().catch((err) => {
  console.error("启动失败：");
  console.error(err);
  process.exit(1);
});


