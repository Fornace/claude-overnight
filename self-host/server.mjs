#!/usr/bin/env node
// Tiny HTTP server that mirrors the fornace enqueue/read shape for OSS users.
// No framework, no DB — everything lives in $PROMPT_EVOLUTION_STORE on disk
// (the docker-compose file bind-mounts ./out there).
//
//   POST /runs                  → spawn claude-overnight-evolve, return runId
//   GET  /runs                  → list run directories
//   GET  /runs/:id              → meta.json + report.md (if present) + status
//   GET  /runs/:id/log          → live stdout/stderr (plain text, tails on disk)
//   GET  /runs/:id/files/<name> → raw artefact (matrix.jsonl, best.md, …)
//   DELETE /runs/:id            → remove a run directory
//
// Auth: if SELF_HOST_TOKEN is set, every request must carry
// `Authorization: Bearer <token>`. Unset means open — fine on a private
// network, not on the public internet.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  createWriteStream,
  rmSync,
} from "node:fs";
import { join, basename, normalize } from "node:path";
import { randomUUID } from "node:crypto";

const STORE = process.env.PROMPT_EVOLUTION_STORE ?? "/out";
const PORT = Number(process.env.PORT ?? 8787);
const BIND = process.env.SELF_HOST_BIND ?? "0.0.0.0";
const TOKEN = process.env.SELF_HOST_TOKEN ?? "";

if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true });

/** Build the argv for claude-overnight-evolve from a JSON body. */
function buildArgs(body, runId) {
  const args = ["--run-id", runId];
  const flagMap = {
    target: "--target",
    prompt: "--prompt",
    promptKind: "--prompt-kind",
    evalModel: "--eval-model",
    mutateModel: "--mutate-model",
    generations: "--generations",
    population: "--population",
    plateau: "--plateau",
    cases: "--cases",
    baseUrl: "--base-url",
  };
  for (const [key, flag] of Object.entries(flagMap)) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      args.push(flag, String(body[key]));
    }
  }
  return args;
}

function safeRunDir(id) {
  const clean = basename(normalize(id));
  if (!clean || clean.startsWith(".")) return null;
  const dir = join(STORE, clean);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return dir;
}

function authOk(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${TOKEN}`;
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body) || typeof body === "string";
  const payload = isBuffer ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": isBuffer ? headers["content-type"] ?? "text/plain; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function enqueue(body) {
  const runId = body.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = join(STORE, runId);
  mkdirSync(dir, { recursive: true });
  const args = buildArgs(body, runId);

  const env = { ...process.env, ...(body.env ?? {}) };
  const logStream = createWriteStream(join(dir, "server.log"), { flags: "a" });
  logStream.write(`$ claude-overnight-evolve ${args.join(" ")}\n`);

  const child = spawn("claude-overnight-evolve", args, {
    cwd: "/workspace",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.on("close", (code) => {
    logStream.write(`\n[exit ${code}]\n`);
    logStream.end();
  });
  child.unref();

  return { runId, pid: child.pid, args };
}

function readRun(id) {
  const dir = safeRunDir(id);
  if (!dir) return null;
  const out = { runId: id, files: readdirSync(dir) };
  for (const file of ["meta.json", "report.md", "best.md"]) {
    const p = join(dir, file);
    if (existsSync(p)) {
      out[file.replace(".", "_")] = readFileSync(p, "utf8");
    }
  }
  if (out.meta_json) {
    try {
      out.meta = JSON.parse(out.meta_json);
    } catch { /* ignore */ }
  }
  return out;
}

function listRuns() {
  return readdirSync(STORE)
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      const metaPath = join(STORE, name, "meta.json");
      if (!existsSync(metaPath)) return { runId: name };
      try {
        return { runId: name, ...JSON.parse(readFileSync(metaPath, "utf8")) };
      } catch {
        return { runId: name };
      }
    })
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

const server = createServer(async (req, res) => {
  try {
    if (!authOk(req)) return send(res, 401, { error: "unauthorized" });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && parts.length === 0) {
      return send(res, 200, { ok: true, store: STORE });
    }

    if (parts[0] !== "runs") return send(res, 404, { error: "not found" });

    if (req.method === "POST" && parts.length === 1) {
      const body = await readJson(req);
      return send(res, 202, enqueue(body));
    }

    if (req.method === "GET" && parts.length === 1) {
      return send(res, 200, listRuns());
    }

    const id = parts[1];
    if (!id) return send(res, 404, { error: "not found" });

    if (req.method === "DELETE" && parts.length === 2) {
      const dir = safeRunDir(id);
      if (!dir) return send(res, 404, { error: "run not found" });
      rmSync(dir, { recursive: true, force: true });
      return send(res, 200, { runId: id, deleted: true });
    }

    if (req.method === "GET" && parts.length === 2) {
      const run = readRun(id);
      if (!run) return send(res, 404, { error: "run not found" });
      return send(res, 200, run);
    }

    if (req.method === "GET" && parts.length === 3 && parts[2] === "log") {
      const dir = safeRunDir(id);
      if (!dir) return send(res, 404, { error: "run not found" });
      const log = join(dir, "server.log");
      const body = existsSync(log) ? readFileSync(log, "utf8") : "";
      return send(res, 200, body, { "content-type": "text/plain; charset=utf-8" });
    }

    if (req.method === "GET" && parts.length === 4 && parts[2] === "files") {
      const dir = safeRunDir(id);
      if (!dir) return send(res, 404, { error: "run not found" });
      const name = basename(normalize(parts[3]));
      const file = join(dir, name);
      if (!existsSync(file) || !statSync(file).isFile()) {
        return send(res, 404, { error: "file not found" });
      }
      return send(res, 200, readFileSync(file), {
        "content-type": name.endsWith(".json") || name.endsWith(".jsonl")
          ? "application/json"
          : "text/plain; charset=utf-8",
      });
    }

    return send(res, 405, { error: "method not allowed" });
  } catch (err) {
    return send(res, 400, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[self-host] listening on ${BIND}:${PORT}, store=${STORE}, auth=${TOKEN ? "on" : "off"}`);
});
