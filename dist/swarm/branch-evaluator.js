import { query } from "@anthropic-ai/claude-agent-sdk";
import { sdkQueryRateLimiter, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
import { withCursorWorkspaceHeader } from "./config.js";
import { renderPrompt } from "../prompts/load.js";
/** Build an evaluator that judges whether partial work is coherent enough to merge. */
export function buildErroredBranchEvaluator(host) {
    const evalModel = host.model;
    if (!evalModel)
        return undefined;
    const envFor = host.config.envForModel;
    return async (agentId, task, diff) => {
        const prompt = renderPrompt("40_skills/40-2_branch-evaluator", { vars: { task, diff } });
        const rl = sdkQueryRateLimiter;
        let eq;
        try {
            await acquireSdkQueryRateLimit();
            eq = query({
                prompt,
                options: {
                    cwd: host.config.cwd, model: evalModel,
                    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
                    maxTurns: 1, persistSession: false,
                    ...(envFor?.(evalModel) && { env: withCursorWorkspaceHeader(envFor(evalModel), host.config.cwd) }),
                },
            });
            host.activeQueries.add(eq);
            let output = "";
            for await (const msg of eq) {
                if (msg.type === "assistant") {
                    const am = msg;
                    if (am.message?.content) {
                        for (const block of am.message.content) {
                            if (block.type === "text" && block.text)
                                output += block.text;
                        }
                    }
                }
                if (msg.type === "result")
                    break;
            }
            const jsonMatch = output.match(/\{[\s\S]*"keep"\s*:\s*(true|false)[\s\S]*"reason"\s*:\s*"[^"]*"[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (typeof parsed.keep === "boolean" && typeof parsed.reason === "string")
                        return parsed;
                }
                catch { }
            }
            host.log(agentId, "Branch eval: could not parse model response, keeping by default");
            return { keep: true, reason: "model response unparseable, keeping by default" };
        }
        catch (err) {
            host.log(agentId, `Branch eval API error: ${String(err?.message || err).slice(0, 120)}`);
            return { keep: true, reason: "eval API error, keeping by default" };
        }
        finally {
            rl.record();
            if (eq) {
                host.activeQueries.delete(eq);
                try {
                    eq.close();
                }
                catch { }
            }
        }
    };
}
