import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { sdkQueryRateLimiter, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
import { withCursorWorkspaceHeader, type SwarmConfig } from "./config.js";
import type { ErroredBranchEvaluator } from "./merge.js";

export interface BranchEvaluatorHost {
  readonly config: SwarmConfig;
  readonly activeQueries: Set<ReturnType<typeof query>>;
  model: string | undefined;
  log(agentId: number, text: string): void;
}

/** Build an evaluator that judges whether partial work is coherent enough to merge. */
export function buildErroredBranchEvaluator(host: BranchEvaluatorHost): ErroredBranchEvaluator | undefined {
  const evalModel = host.model;
  if (!evalModel) return undefined;
  const envFor = host.config.envForModel;

  return async (agentId: number, task: string, diff: string): Promise<{ keep: boolean; reason: string }> => {
    const prompt = `You are evaluating whether partial work from an agent that errored mid-task should be kept or discarded.

Task: "${task}"

Diff of changes:
\`\`\`
${diff}
\`\`\`

Is this partial work coherent enough to land? Consider:
- Does it implement a meaningful portion of the task?
- Are the changes self-consistent (no half-written functions, broken imports)?
- Would merging this improve or degrade the codebase?

Respond with JSON: {"keep": true/false, "reason": "brief explanation"}`;

    const rl = sdkQueryRateLimiter;
    let eq: ReturnType<typeof query> | undefined;
    try {
      await acquireSdkQueryRateLimit();
      eq = query({
        prompt,
        options: {
          cwd: host.config.cwd, model: evalModel,
          permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
          maxTurns: 1, persistSession: false,
          ...(envFor?.(evalModel) && { env: withCursorWorkspaceHeader(envFor!(evalModel), host.config.cwd)! }),
        },
      });
      host.activeQueries.add(eq);
      let output = "";
      for await (const msg of eq) {
        if (msg.type === "assistant") {
          const am = msg as SDKAssistantMessage;
          if (am.message?.content) {
            for (const block of am.message.content) {
              if (block.type === "text" && block.text) output += block.text;
            }
          }
        }
        if (msg.type === "result") break;
      }
      const jsonMatch = output.match(/\{[\s\S]*"keep"\s*:\s*(true|false)[\s\S]*"reason"\s*:\s*"[^"]*"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { keep: boolean; reason: string };
          if (typeof parsed.keep === "boolean" && typeof parsed.reason === "string") return parsed;
        } catch {}
      }
      host.log(agentId, "Branch eval: could not parse model response, keeping by default");
      return { keep: true, reason: "model response unparseable, keeping by default" };
    } catch (err: any) {
      host.log(agentId, `Branch eval API error: ${String(err?.message || err).slice(0, 120)}`);
      return { keep: true, reason: "eval API error, keeping by default" };
    } finally {
      rl.record();
      if (eq) { host.activeQueries.delete(eq); try { eq.close(); } catch {} }
    }
  };
}
