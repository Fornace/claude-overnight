import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { getTranscriptRunDir } from "../../core/transcripts.js";
import type { TranscriptEvent } from "../../core/transcripts.js";
import { useTranscriptTail } from "../hooks/use-transcript-tail.js";
import { useScrollBuffer } from "../hooks/use-scroll-buffer.js";

function stallLabel(events: TranscriptEvent[]): React.ReactElement {
  if (events.length === 0) return <Text>{chalk.dim("no events yet")}</Text>;
  const last = events[events.length - 1];
  const age = Date.now() - last.t;
  const seconds = Math.floor(age / 1000);

  if (seconds < 5) return <Text>{chalk.green("● streaming")}</Text>;
  if (seconds < 15) return <Text>{chalk.yellow(`◐ waiting ${seconds}s\u2026`)}</Text>;
  if (seconds < 30) return <Text>{chalk.yellow(`◑ retrying (${Math.min(Math.floor(seconds / 10), 3)}/3)\u2026`)}</Text>;
  return <Text>{chalk.red("◑ stalled")}</Text>;
}

function renderEvent(evt: TranscriptEvent): string {
  const { type, payload } = evt;

  if (type === "assistant" || type === "result") {
    const text = extractText(payload);
    return text ? chalk.white(truncate(text, 200)) : chalk.dim(`[${type}]`);
  }

  if (type === "tool_use") {
    const name = (payload.name as string) ?? "unknown";
    const input = payload.input as Record<string, unknown> | undefined;
    const summary = input ? toolSummary(name, input) : name;
    return chalk.yellow(`▸ ${summary}`);
  }

  if (type === "tool_result") {
    const toolName = (payload.tool_name as string) ?? (payload.tool_use_id as string) ?? "result";
    const isError = payload.is_error as boolean;
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

function extractText(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        return String((block as Record<string, unknown>).text ?? "");
      }
    }
  }
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.delta === "object" && payload.delta && typeof (payload.delta as Record<string, unknown>).text === "string") {
    return (payload.delta as Record<string, unknown>).text as string;
  }
  return null;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = Object.values(input)[0];
  if (name === "Read" || name === "read_file") return `Read(${truncate(String(first ?? ""), 30)})`;
  if (name === "Write" || name === "write_file") return `Write(${truncate(String(first ?? ""), 30)})`;
  if (name === "Edit" || name === "replace") return `Edit(${truncate(String(first ?? ""), 30)})`;
  if (name === "Bash" || name === "bash") return `Bash(${truncate(String(first ?? ""), 40)})`;
  if (name === "Grep" || name === "grep") return `Grep(${truncate(String(first ?? ""), 30)})`;
  return `${name}()`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

export type StreamViewMode = "events" | `stream:${string}`;

export interface StreamPaneProps {
  streamId?: string;
  agentId?: number;
  viewMode?: StreamViewMode;
  onViewModeChange?: (mode: StreamViewMode) => void;
}

export function StreamPane({ streamId, agentId, viewMode, onViewModeChange }: StreamPaneProps) {
  const streamPath = useMemo(
    () => streamId
      ? `${getTranscriptRunDir()}/transcripts/streams/${streamId}.ndjson`
      : undefined,
    [streamId],
  );

  const events = useTranscriptTail(streamPath);
  const [visibleRows, setVisibleRows] = useState(20);

  // Refresh the stall label only when its age crosses a threshold (5s/15s/30s).
  const [, bumpStall] = useState(0);
  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return;
    const age = Date.now() - last.t;
    const next = age < 5_000 ? 5_000 - age
      : age < 15_000 ? 15_000 - age
      : age < 30_000 ? 30_000 - age
      : null;
    if (next == null) return;
    const id = setTimeout(() => bumpStall(t => t + 1), next + 50);
    return () => clearTimeout(id);
  }, [events]);

  useEffect(() => {
    setVisibleRows(Math.max(8, (process.stdout.rows ?? 24) - 8));
  }, []);

  const { viewportItems, isFollowing, handleKeyDown } = useScrollBuffer<TranscriptEvent>(events, visibleRows);

  useInput(
    useCallback(
      (input, key) => {
        if (key.return && onViewModeChange) {
          onViewModeChange(viewMode === "events" ? `stream:${streamId ?? "planner"}` : "events");
          return;
        }
        handleKeyDown({ key: input });
      },
      [handleKeyDown, onViewModeChange, viewMode, streamId],
    ),
    { isActive: true },
  );

  const footer = isFollowing
    ? chalk.dim("\u2502 following tail")
    : chalk.cyan("\u2502 scroll \u2191\u2193 PgUp PgDn End=g");

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" paddingX={1}>
        <Text bold>
          {streamId ? chalk.cyan(`stream:${streamId}`) : chalk.magenta("events")}
        </Text>
        {agentId != null && <Text> {chalk.dim(`agent ${agentId}`)}</Text>}
        <Box flexGrow={1} />
        {stallLabel(events)}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {viewportItems.map((evt, i) => (
          <Text key={`${evt.t}-${i}`}>{renderEvent(evt)}</Text>
        ))}
      </Box>
      <Box paddingLeft={1}>
        <Text>{footer}</Text>
      </Box>
    </Box>
  );
}
