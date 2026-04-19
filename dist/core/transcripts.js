import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
/**
 * Crash-safe NDJSON transcripts. One JSON object per line survives partial writes.
 * Planner/steering live at `<runDir>/transcripts/<name>.ndjson`; per-stream agent
 * transcripts at `<runDir>/transcripts/streams/<streamId>.ndjson`.
 */
let _runDir;
export function setTranscriptRunDir(dir) {
    _runDir = dir;
}
export function getTranscriptRunDir() {
    return _runDir;
}
export function transcriptPath(name) {
    return _runDir ? join(_runDir, "transcripts", `${name}.ndjson`) : undefined;
}
const _seenErrors = new Set();
export function writeTranscriptEvent(name, event) {
    const path = transcriptPath(name);
    if (!path)
        return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify({ t: Date.now(), ...event }) + "\n", "utf-8");
    }
    catch (err) {
        if (!_seenErrors.has(name)) {
            _seenErrors.add(name);
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[transcript] writeTranscriptEvent("${name}") failed: ${msg}\n`);
        }
    }
}
// Keyed subscription: avoids O(N) fanout when many guards each filter for one stream.
const _listeners = new Map();
export function onStreamEvent(streamId, fn) {
    let set = _listeners.get(streamId);
    if (!set) {
        set = new Set();
        _listeners.set(streamId, set);
    }
    set.add(fn);
    return () => {
        const s = _listeners.get(streamId);
        if (!s)
            return;
        s.delete(fn);
        if (s.size === 0)
            _listeners.delete(streamId);
    };
}
function dispatchStreamEvent(streamId, evt) {
    const set = _listeners.get(streamId);
    if (!set)
        return;
    for (const fn of set) {
        try {
            fn(evt);
        }
        catch { /* listener errors must not break the sink */ }
    }
}
export class StreamSink {
    streamId;
    agentId;
    lastByteAt;
    eventCount = 0;
    finished = false;
    _path;
    constructor(streamId, agentId) {
        this.streamId = streamId;
        this.agentId = agentId;
        this.lastByteAt = Date.now();
        if (_runDir) {
            this._path = join(_runDir, "transcripts", "streams", `${streamId}.ndjson`);
            mkdirSync(dirname(this._path), { recursive: true });
        }
    }
    append(msg) {
        const evt = {
            t: Date.now(),
            type: msg.type,
            payload: msg,
            meta: { streamId: this.streamId, agentId: this.agentId },
        };
        this.lastByteAt = evt.t;
        this.eventCount++;
        if (this._path) {
            try {
                appendFileSync(this._path, JSON.stringify(evt) + "\n");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[StreamSink] append("${this.streamId}") failed: ${msg}\n`);
            }
        }
        dispatchStreamEvent(this.streamId, evt);
    }
    markFinished() {
        this.finished = true;
    }
    get path() {
        return this._path;
    }
}
