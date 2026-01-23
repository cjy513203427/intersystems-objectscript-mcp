import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const client = new Client({ name: "ping-demo-client", version: "0.1.0" });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: process.cwd(),
    // Pipe stderr so we can see server logs without mixing with stdout protocol stream.
    stderr: "pipe",
    env: {
      ...toStringEnv(process.env),
    },
  });

  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

  const result = await client.callTool({ name: "ping", arguments: {} });
  console.log("ping result:", result);

  await client.close();
  await transport.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


