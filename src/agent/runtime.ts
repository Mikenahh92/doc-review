// agentRuntime — THE SWAP BOUNDARY. The only module that knows pi exists.
// Backend -> spawnAgent(systemPrompt, userPrompt, tools, resumeFrom) -> the ONE persistent
// pi session, resumed per phase with a different system prompt/task (plan -> task1 -> ... -> complete).
// pi agent -> tool calls cross straight back into backend app API (see tools.ts).

import {
  Agent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
// @ts-ignore — lazy api module without bundled types
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type RuntimeMode = "faux" | "ollama" | "remote";

export interface RuntimeConfig {
  mode: RuntimeMode;
  modelId?: string;   // ollama/remote: model id
  baseUrl?: string;   // ollama/remote: e.g. http://localhost:11434/v1
  apiKey?: string;    // remote: bearer key (never needed for ollama/faux)
  concurrency?: number; // parallel verify tasks (DR-10)
  maxAttempts?: number; // attempts per task before parking as blocked
}

export interface SessionOutcome {
  toolCallsMade: number;
  error?: string;
  lastText: string;
  messages: any[];     // full transcript so far — pass back as resumeFrom for the next phase
}

interface Resolved {
  models: Models;
  model: Model<string>;
  faux?: FauxProviderHandle;
}

export function resolveRuntime(config: RuntimeConfig): Resolved {
  if (config.mode === "ollama" || config.mode === "remote") {
    const isRemote = config.mode === "remote";
    const baseUrl = config.baseUrl ?? (isRemote ? "http://localhost:11434/v1" : "http://localhost:11434/v1");
    const modelId = config.modelId ?? "llama-3.1-8b";
    const apiKey = config.apiKey ?? "";
    const model: Model<"openai-completions"> = {
      id: modelId,
      name: `${modelId} (${isRemote ? "remote" : "local"})`,
      api: "openai-completions",
      provider: isRemote ? "remote" : "ollama",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 32000,
    };
    const provider = createProvider({
      id: isRemote ? "remote" : "ollama",
      name: isRemote ? "Remote (OpenAI-compatible)" : "Ollama (local)",
      baseUrl,
      auth: {
        apiKey: {
          name: isRemote ? "API key" : "Ollama",
          resolve: async () => ({ auth: apiKey ? { apiKey } : {} }),
        },
      },
      models: [model],
      // @ts-ignore lazy api module
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);
    return { models, model };
  }
  if (false) {
    const baseUrl = config.baseUrl ?? "http://localhost:11434/v1";
    const modelId = config.modelId ?? "llama-3.1-8b";
    const model: Model<"openai-completions"> = {
      id: modelId,
      name: `${modelId} (local)`,
      api: "openai-completions",
      provider: "ollama",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 32000,
    };
    const provider = createProvider({
      id: "ollama",
      name: "Ollama (local)",
      baseUrl,
      auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: {} }) } },
      models: [model],
      // @ts-ignore lazy api module
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);
    return { models, model };
  }
  // default: faux (deterministic, for tests/demo without a model server)
  // module-level singleton so tests can queue responses before spawning sessions
  const g = globalThis as any;
  if (!g.__fauxHandle) {
    g.__fauxHandle = fauxProvider();
    const m = createModels();
    m.setProvider(g.__fauxHandle.provider);
    g.__fauxModels = m;
  }
  const faux = g.__fauxHandle as FauxProviderHandle;
  return { models: g.__fauxModels as Models, model: faux.getModel(), faux };
}

export interface SpawnOptions {
  systemPrompt: string;
  userPrompt: string;
  tools: AgentTool<any>[];
  config: RuntimeConfig;
  onToolCall?: (name: string, args: unknown) => void;
  resumeFrom?: any[];   // transcript of the ONE persistent session — resumed with a new system prompt
}

export async function spawnAgent(opts: SpawnOptions): Promise<SessionOutcome> {
  const { models, model } = resolveRuntime(opts.config);
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,   // SWAPPED per phase (plan / task / complete)
      model,
      tools: opts.tools,
      messages: opts.resumeFrom ?? [],   // transcript carries over → ONE continuous session
    },
    streamFn: models.streamSimple.bind(models),
  });

  let toolCallsMade = 0;
  let lastText = "";
  agent.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      toolCallsMade++;
      opts.onToolCall?.(event.toolName, event.args);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const c of event.message.content ?? []) {
        if (c.type === "text") lastText = c.text;
      }
    }
  });

  let error: string | undefined;
  try {
    await agent.prompt(opts.userPrompt);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  const em = (agent.state as any).errorMessage;
  return { toolCallsMade, error: error ?? em, lastText, messages: agent.state.messages as any[] };
}

/** For tests/demo: expose the faux handle so scripted responses can be queued. */
export function fauxHandle(config: RuntimeConfig): FauxProviderHandle | undefined {
  return config.mode === "faux" ? (resolveRuntime(config) as Resolved).faux : undefined;
}
