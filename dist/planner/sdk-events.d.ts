export type BlockStart = {
    type: "tool_use";
    id: string;
    name: string;
    input?: Record<string, unknown>;
} | {
    type: "thinking";
} | {
    type: "redacted_thinking";
} | {
    type: "text";
    text?: string;
};
export type BlockDelta = {
    type: "input_json_delta";
    partial_json: string;
} | {
    type: "text_delta";
    text: string;
} | {
    type: "thinking_delta";
    thinking: string;
};
/**
 * The three streaming-event variants we react to. The SDK actually emits
 * many more (`message_start`, `message_delta`, `ping`, …) — those fall
 * through to the `default` arm in our switch and are deliberately ignored.
 */
export type StreamEvent = {
    type: "content_block_start";
    index?: number;
    content_block?: BlockStart;
} | {
    type: "content_block_delta";
    index?: number;
    delta?: BlockDelta;
} | {
    type: "content_block_stop";
    index?: number;
};
/** Token-usage fragment present on `assistant` SDK messages. */
export interface AssistantUsage {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
}
/** Per-window rate-limit fragment carried on `rate_limit_event` SDK messages. */
export interface RateLimitInfoFragment {
    utilization?: number;
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
    isUsingOverage?: boolean;
}
