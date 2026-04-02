#!/usr/bin/env node
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
  IRIS_NAMESPACE: z.string().min(1, "IRIS_NAMESPACE is required"),
  IRIS_USERNAME: z.string().min(1, "IRIS_USERNAME is required").default("_SYSTEM"),
  IRIS_PASSWORD: z.string().min(1, "IRIS_PASSWORD is required").default("SYS"),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logs must go to stderr in stdio mode to avoid corrupting the protocol stream.
    console.error("Environment variable validation failed:");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRoutineDocCandidates(inputName: string): string[] {
  // Candidates are tried in order; keep it conservative and predictable.
  const name = inputName.trim();
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (v: string) => {
    const vv = v.trim();
    if (!vv) return;
    if (seen.has(vv)) return;
    seen.add(vv);
    out.push(vv);
  };

  // If user provides a class name (with or without .cls), prefer the compiled routine (.1.int).
  if (/\.cls$/i.test(name)) {
    add(name.replace(/\.cls$/i, ".1.int"));
    add(name.replace(/\.cls$/i, ".int"));
    return out;
  }

  // If user provides a routine name already.
  if (/\.int$/i.test(name) || /\.mac$/i.test(name) || /\.inc$/i.test(name)) {
    add(name);
    return out;
  }

  // Bare class name: try common compiled routine name shapes first.
  add(`${name}.1.int`);
  add(`${name}.int`);
  // As a last resort, try the input verbatim (might already be a doc name on some systems).
  add(name);
  return out;
}

function isLikelyNetworkMisconfig(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return false;
  const code = err.code ?? "";
  return [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ].includes(code);
}

function shouldRetryOnce(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  // Only retry a small set of transient server errors.
  return status === 502 || status === 503 || status === 504;
}

async function verifyConnection(env: Env): Promise<void> {
  const client = createIrisClient(env);

  try {
    // user_story.md step2 expects /api/atelier/ as the first HTTP link.
    const res = await client.get("/api/atelier/");
    console.error("IRIS connection successful.");
    console.error(`HTTP ${res.status}`);
    console.error(`Atelier info: ${extractVersionInfo(res.data)}`);
  } catch (err: unknown) {
    console.error("IRIS connection failed.");
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
  await verifyConnection(env);

  const server = new McpServer({
    name: "intersystems-objectscript-routine-mcp",
    version: "1.0.1",
  });

  server.registerTool(
    "get_iris_routine",
    {
      description:
        "Read-only: fetch routine or include file content from IRIS. Supports .int, .mac, and .inc files. " +
        "Auto-completes bare class names (e.g. 'Pkg.Class') by trying '.1.int' and '.int'. " +
        "To fetch an include file, pass the full name with extension (e.g. '%occCPTJSgen.inc'). Does not modify any code.",
      inputSchema: z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ name, namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      const client = createIrisClient(env);

      const candidates = buildRoutineDocCandidates(name);
      const tried: Array<{ name: string; status?: number; message?: string }> = [];

      for (const candidate of candidates) {
        const url = `/api/atelier/v1/${encodeURIComponent(resolvedNamespace)}/doc/${encodeURIComponent(candidate)}`;

        // Important: keep this tool responsive. Avoid long hangs on misconfigured ports.
        // We do a single attempt per candidate, and at most one extra retry for transient 5xx.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await client.get(url, { timeout: 10_000 });
            // Atelier doc responses are typically { result: { name, cat, content: string[] } }.
            const result = res.data?.result ?? res.data;
            const lines = Array.isArray(result?.content) ? result.content : null;
            const header = `[IRIS routine] name=${String(result?.name ?? candidate)} cat=${String(
              result?.cat ?? "unknown",
            )}`;
            const content = lines
              ? `${header}\n${lines.join("\n")}`
              : `${header}\n${extractVersionInfo(res.data)}`;
            return {
              content: [{ type: "text", text: content }],
            };
          } catch (err: unknown) {
            if (isLikelyNetworkMisconfig(err)) {
              // Fast-fail for common port/DNS/timeout issues; don't keep the user waiting.
              const ax = axios.isAxiosError(err) ? err : null;
              const code = ax?.code ? ` (${ax.code})` : "";
              const hint =
                `Cannot connect to IRIS${code}. Check IRIS_URL/port, network reachability, and Basic Auth.` +
                `\n- IRIS_URL: ${env.IRIS_URL}` +
                `\n- Try: ${normalizeBaseUrl(env.IRIS_URL)}/api/atelier/`;
              return { content: [{ type: "text", text: hint }] };
            }

            if (axios.isAxiosError(err)) {
              const status = err.response?.status;
              tried.push({ name: candidate, status, message: err.message });

              // Not a valid doc name or not found => try next candidate.
              if (status === 400 || status === 404) break;

              // Auth / permission issues should surface immediately.
              if (status === 401 || status === 403) {
                const snippet = extractVersionInfo(err.response?.data ?? err.message);
                return {
                  content: [{ type: "text", text: `Authentication or authorization failed (HTTP ${status}).\n${snippet}` }],
                };
              }

              // Retry once for transient 5xx, then fall through to return a generic error.
              if (attempt === 0 && shouldRetryOnce(err)) {
                await sleep(250);
                continue;
              }

              const snippet = extractVersionInfo(err.response?.data ?? err.message);
              return {
                content: [{ type: "text", text: `Failed to fetch routine (HTTP ${status ?? "unknown"}).\n${snippet}` }],
              };
            }

            // Non-Axios errors: return a generic failure without retry loops.
            return { content: [{ type: "text", text: `Failed to fetch routine: ${String(err)}` }] };
          }
        }
      }

      // If we reach here, all candidates were 400/404.
      const list = candidates.map((c) => `- ${c}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `No compiled routine was found. Please verify the class has been compiled.\n\n` +
              `Tried the following names:\n${list}\n\n` +
              `Also verify namespace: ${resolvedNamespace}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_iris_includes",
    {
      description:
        "Read-only: list all accessible .inc (include) files in an IRIS namespace via SQL. " +
        "Use this to discover which include files are available before fetching one with get_iris_routine. " +
        "Does not modify any code.",
      inputSchema: z.object({
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      const client = createIrisClient(env);
      const url = `/api/atelier/v1/${encodeURIComponent(resolvedNamespace)}/action/query`;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await client.post(
            url,
            {
              query:
                "SELECT Name FROM %Library.RoutineMgr_StudioOpenDialog('*.inc',1,1,1,1,0,0)",
              parameters: [],
            },
            { timeout: 30_000 },
          );

          // Atelier action/query response varies by IRIS version:
          // older: { result: { columns: [...], rows: [[val,...], ...] } }
          // newer: { result: { content: [{ Name: "..." }, ...] } }
          // Handle both shapes.
          const result = res.data?.result ?? res.data;
          const rawRows: unknown[] =
            Array.isArray(result?.rows) ? result.rows :
            Array.isArray(result?.content) ? result.content : [];

          const names: string[] = rawRows.map((row) => {
            if (Array.isArray(row)) return String(row[0] ?? "");
            if (row !== null && typeof row === "object") {
              const obj = row as Record<string, unknown>;
              return String(obj["Name"] ?? obj["name"] ?? "");
            }
            return String(row ?? "");
          }).filter(Boolean);

          if (names.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `No .inc files found in namespace: ${resolvedNamespace}\n` +
                    `The query succeeded but returned 0 rows. ` +
                    `Try a different namespace or verify SQL access to %Library.RoutineMgr_StudioOpenDialog.`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text:
                  `[IRIS include files] namespace=${resolvedNamespace} count=${names.length}\n` +
                  names.join("\n"),
              },
            ],
          };
        } catch (err: unknown) {
          if (isLikelyNetworkMisconfig(err)) {
            const ax = axios.isAxiosError(err) ? err : null;
            const code = ax?.code ? ` (${ax.code})` : "";
            const hint =
              `Cannot connect to IRIS${code}. Check IRIS_URL/port, network reachability, and Basic Auth.` +
              `\n- IRIS_URL: ${env.IRIS_URL}` +
              `\n- Try: ${normalizeBaseUrl(env.IRIS_URL)}/api/atelier/`;
            return { content: [{ type: "text", text: hint }] };
          }

          if (axios.isAxiosError(err)) {
            const status = err.response?.status;

            if (status === 401 || status === 403) {
              const snippet = extractVersionInfo(err.response?.data ?? err.message);
              return {
                content: [{ type: "text", text: `Authentication or authorization failed (HTTP ${status}).\n${snippet}` }],
              };
            }

            if (attempt === 0 && shouldRetryOnce(err)) {
              await sleep(250);
              continue;
            }

            const snippet = extractVersionInfo(err.response?.data ?? err.message);
            return {
              content: [{ type: "text", text: `Failed to list include files (HTTP ${status ?? "unknown"}).\n${snippet}` }],
            };
          }

          return { content: [{ type: "text", text: `Failed to list include files: ${String(err)}` }] };
        }
      }

      // Should be unreachable, but satisfy the compiler.
      return { content: [{ type: "text", text: "Failed to list include files: unexpected state." }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Important: use stderr for logs in stdio transport.
  console.error("MCP server started (stdio).");
}

main().catch((err) => {
  console.error("Startup failed:");
  console.error(err);
  process.exit(1);
});


