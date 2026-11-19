/** GA-516 pi cross-check (run from doc-review root so pi node_modules resolve):
 *  a real pi-agent-core Agent, driven by the scripted faux provider, whose tool
 *  bridges into GA's MCP endpoint (http://localhost:18090/mcp). Proves the /mcp
 *  surface is consumable by the pi runtime as a plain tool source. */
import { Agent, } from "@earendil-works/pi-agent-core";
import { createModels, } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, } from "@earendil-works/pi-ai/providers/faux";

const GA = "http://localhost:18090/mcp";
const TOKEN = "ga516-test-token";
let rpcId = 1;

async function mcp(name, args = {}) {
  const res = await fetch(GA, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`MCP ${name} -> HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`MCP ${name} -> ${j.error.message}`);
  return j.result.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

/* one bridged pi tool: GA's plan.templates.list as a pi AgentTool */
const gaTemplates = {
  name: "ga_plan_templates",
  label: "GA plan templates via MCP",
  description: "Lists the plan templates available in the Generalist Agent orchestrator (via its MCP endpoint).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(toolCallId, params) {
    const text = await mcp("plan.templates.list");
    return { content: [{ type: "text", text: text || "(none)" }], details: { source: "ga-mcp" } };
  },
};

const g = globalThis;
if (!g.__fauxHandle) {
  g.__fauxHandle = fauxProvider();
  const m = createModels();
  m.setProvider(g.__fauxHandle.provider);
  g.__fauxModels = m;
}
const faux = g.__fauxHandle;
const models = g.__fauxModels;
let turn = 0;
faux.setResponses([
  () => { turn++; return turn === 1
    ? fauxAssistantMessage([fauxToolCall("ga_plan_templates", {})], { stopReason: "toolUse" })
    : fauxAssistantMessage([{ type: "text", text: "GA templates retrieved via MCP bridge." }], { stopReason: "endTurn" }); },
]);

const agent = new Agent({
  initialState: {
    systemPrompt: "You fetch plan templates from the GA orchestrator.",
    model: faux.getModel(),
    tools: [gaTemplates],
    messages: [],
  },
  streamFn: models.streamSimple.bind(models),
});

let toolResults = "";
agent.subscribe((ev) => {
  if (ev.type === "tool_execution_end") toolResults = JSON.stringify(ev.result?.content ?? "");
});
await new Promise((resolve, reject) => {
  agent.subscribe((ev) => { if (ev.type === "agent_end") resolve(); });
  agent.prompt("List the GA plan templates.").catch(reject);
});

if (!toolResults) { console.error("PI TEST FAIL: no tool result captured"); process.exit(1); }
console.log("PI TEST PASS: pi agent executed GA MCP tool through the bridge");
console.log("  tool result head:", toolResults.slice(0, 140));
