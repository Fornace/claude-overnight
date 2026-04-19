import { useEffect, useRef, useState, useCallback } from "react";
import { existsSync, openSync, closeSync, readSync, statSync, watch } from "fs";
const MAX_EVENTS = 2000;
// Safety poll — only runs when fs.watch couldn't be attached.
const FALLBACK_POLL_MS = 1000;
const READ_CHUNK = 64 * 1024;
export function useTranscriptTail(streamPath) {
    const [events, setEvents] = useState([]);
    const offsetRef = useRef(0);
    const eventsRef = useRef([]);
    const carryRef = useRef("");
    const reset = useCallback(() => {
        offsetRef.current = 0;
        eventsRef.current = [];
        carryRef.current = "";
        setEvents([]);
    }, []);
    const appendEvents = useCallback((text) => {
        if (!text)
            return;
        const buf = carryRef.current + text;
        const lines = buf.split("\n");
        carryRef.current = lines.pop() ?? "";
        const parsed = [];
        for (const line of lines) {
            if (!line)
                continue;
            try {
                parsed.push(JSON.parse(line));
            }
            catch { /* skip corrupt */ }
        }
        if (parsed.length === 0)
            return;
        const prev = eventsRef.current;
        const next = prev.length + parsed.length > MAX_EVENTS
            ? [...prev, ...parsed].slice(-MAX_EVENTS)
            : [...prev, ...parsed];
        eventsRef.current = next;
        setEvents(next);
    }, []);
    const readNew = useCallback((path) => {
        if (!existsSync(path))
            return;
        let fd;
        try {
            const stat = statSync(path);
            if (stat.size < offsetRef.current) {
                reset();
            }
            if (stat.size <= offsetRef.current)
                return;
            fd = openSync(path, "r");
            const chunk = Buffer.alloc(READ_CHUNK);
            let pos = offsetRef.current;
            while (pos < stat.size) {
                const n = readSync(fd, chunk, 0, chunk.length, pos);
                if (n <= 0)
                    break;
                appendEvents(chunk.subarray(0, n).toString("utf-8"));
                pos += n;
            }
            offsetRef.current = pos;
        }
        catch { /* file raced away */ }
        finally {
            if (fd != null)
                try {
                    closeSync(fd);
                }
                catch { }
        }
    }, [reset, appendEvents]);
    useEffect(() => {
        reset();
        if (!streamPath)
            return;
        readNew(streamPath);
        let watcher;
        let fallback;
        try {
            watcher = watch(streamPath, { persistent: false }, () => readNew(streamPath));
        }
        catch {
            fallback = setInterval(() => readNew(streamPath), FALLBACK_POLL_MS);
        }
        return () => {
            watcher?.close();
            if (fallback)
                clearInterval(fallback);
        };
    }, [streamPath, reset, readNew]);
    return events;
}
