import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { getTranscriptRunDir } from "../../core/transcripts.js";
import { useTranscriptTail } from "../hooks/use-transcript-tail.js";
import { useScrollBuffer } from "../hooks/use-scroll-buffer.js";
function stallLabel(events) {
    if (events.length === 0)
        return _jsx(Text, { children: chalk.dim("no events yet") });
    const last = events[events.length - 1];
    const age = Date.now() - last.t;
    const seconds = Math.floor(age / 1000);
    if (seconds < 5)
        return _jsx(Text, { children: chalk.green("● streaming") });
    if (seconds < 15)
        return _jsx(Text, { children: chalk.yellow(`◐ waiting ${seconds}s\u2026`) });
    if (seconds < 30)
        return _jsx(Text, { children: chalk.yellow(`◑ retrying (${Math.min(Math.floor(seconds / 10), 3)}/3)\u2026`) });
    return _jsx(Text, { children: chalk.red("◑ stalled") });
}
function renderEvent(evt) {
    const { type, payload } = evt;
    if (type === "assistant" || type === "result") {
        const text = extractText(payload);
        return text ? chalk.white(truncate(text, 200)) : chalk.dim(`[${type}]`);
    }
    if (type === "tool_use") {
        const name = payload.name ?? "unknown";
        const input = payload.input;
        const summary = input ? toolSummary(name, input) : name;
        return chalk.yellow(`▸ ${summary}`);
    }
    if (type === "tool_result") {
        const toolName = payload.tool_name ?? payload.tool_use_id ?? "result";
        const isError = payload.is_error;
        return isError ? chalk.red(`✗ ${toolName}`) : chalk.dim(`✓ ${toolName}`);
    }
    if (type === "stream_event") {
        return chalk.dim(`[${type}]`);
    }
    if (type === "rate_limit_event") {
        return chalk.red(`[rate limit: ${payload.type ?? "unknown"}]`);
    }
    return chalk.dim(`[${type}]`);
}
function extractText(payload) {
    const content = payload.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block && typeof block === "object" && block.type === "text") {
                return String(block.text ?? "");
            }
        }
    }
    if (typeof payload.text === "string")
        return payload.text;
    if (typeof payload.delta === "object" && payload.delta && typeof payload.delta.text === "string") {
        return payload.delta.text;
    }
    return null;
}
function toolSummary(name, input) {
    const first = Object.values(input)[0];
    if (name === "Read" || name === "read_file")
        return `Read(${truncate(String(first ?? ""), 30)})`;
    if (name === "Write" || name === "write_file")
        return `Write(${truncate(String(first ?? ""), 30)})`;
    if (name === "Edit" || name === "replace")
        return `Edit(${truncate(String(first ?? ""), 30)})`;
    if (name === "Bash" || name === "bash")
        return `Bash(${truncate(String(first ?? ""), 40)})`;
    if (name === "Grep" || name === "grep")
        return `Grep(${truncate(String(first ?? ""), 30)})`;
    return `${name}()`;
}
function truncate(s, max) {
    return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
export function StreamPane({ streamId, agentId, viewMode, onViewModeChange }) {
    const streamPath = useMemo(() => streamId
        ? `${getTranscriptRunDir()}/transcripts/streams/${streamId}.ndjson`
        : undefined, [streamId]);
    const events = useTranscriptTail(streamPath);
    const [visibleRows, setVisibleRows] = useState(20);
    // Refresh the stall label only when its age crosses a threshold (5s/15s/30s).
    const [, bumpStall] = useState(0);
    useEffect(() => {
        const last = events[events.length - 1];
        if (!last)
            return;
        const age = Date.now() - last.t;
        const next = age < 5_000 ? 5_000 - age
            : age < 15_000 ? 15_000 - age
                : age < 30_000 ? 30_000 - age
                    : null;
        if (next == null)
            return;
        const id = setTimeout(() => bumpStall(t => t + 1), next + 50);
        return () => clearTimeout(id);
    }, [events]);
    useEffect(() => {
        setVisibleRows(Math.max(8, (process.stdout.rows ?? 24) - 8));
    }, []);
    const { viewportItems, isFollowing, handleKeyDown } = useScrollBuffer(events, visibleRows);
    useInput(useCallback((input, key) => {
        if (key.return && onViewModeChange) {
            onViewModeChange(viewMode === "events" ? `stream:${streamId ?? "planner"}` : "events");
            return;
        }
        handleKeyDown({ key: input });
    }, [handleKeyDown, onViewModeChange, viewMode, streamId]), { isActive: true });
    const footer = isFollowing
        ? chalk.dim("\u2502 following tail")
        : chalk.cyan("\u2502 scroll \u2191\u2193 PgUp PgDn End=g");
    return (_jsxs(Box, { flexDirection: "column", flexGrow: 1, children: [_jsxs(Box, { flexDirection: "row", paddingX: 1, children: [_jsx(Text, { bold: true, children: streamId ? chalk.cyan(`stream:${streamId}`) : chalk.magenta("events") }), agentId != null && _jsxs(Text, { children: [" ", chalk.dim(`agent ${agentId}`)] }), _jsx(Box, { flexGrow: 1 }), stallLabel(events)] }), _jsx(Box, { flexDirection: "column", flexGrow: 1, paddingLeft: 1, children: viewportItems.map((evt, i) => (_jsx(Text, { children: renderEvent(evt) }, `${evt.t}-${i}`))) }), _jsx(Box, { paddingLeft: 1, children: _jsx(Text, { children: footer }) })] }));
}
