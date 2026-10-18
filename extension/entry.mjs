// PI-Desktop adapter for billion-context-pi.
//
// Upstream targets the Pi coding agent. Two host expectations do not hold on
// PI-Desktop, and both are answered here rather than by patching upstream:
//
//  1. Host support. Upstream requires `sessionManager.buildContextEntries()` and
//     otherwise classifies the host as unsupported, refusing to compress at all.
//     PI-Desktop is a Pi-compatible fork that exposes `getBranch()` instead, so
//     this adapter declares it — `PI_ACP_FORK_HOST` is the supported declaration.
//
//  2. Durable fold state. Upstream keys its compression state off
//     `sessionManager.getSessionFile()` and keeps nothing when that is absent
//     (its `stateFileFor` returns null and the store is memory-only). PI-Desktop
//     exposes no session log path, so every fold was lost on quit. This adapter
//     supplies a stable per-session path under the plugin data directory;
//     upstream then writes and reloads its own sidecar file normally.
//
// A context is handed to an extension in three places — event handlers, tool
// `execute`, and command `handler` — and upstream persists from all of them, so
// all three get the adapter context. Everything else is upstream: the vendored
// copy is pinned, upstream's self-update stays off (it would npm-install over
// files inside the installed plugin), and fixes arrive by re-vendoring.

import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

process.env.PI_ACP_FORK_HOST = "1";
process.env.ACP_AUTO_UPDATE = "0";

const upstream = await import("../vendor/billion-context-pi/dist/index.js");

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "acp-desktop");
mkdirSync(STATE_DIR, { recursive: true });

function stateFileFor(sessionId) {
  // Session ids are host-generated, but never trust that for a filename.
  const safe = String(sessionId || "session").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return path.join(STATE_DIR, `${safe}.jsonl`);
}

// Borrow the host's sessionManager but answer getSessionFile with our path, so
// upstream's `.acp.json` sidecar lands somewhere we can find again on restart.
function withSessionFile(ctx) {
  const sm = ctx?.sessionManager;
  if (!sm || typeof sm.getSessionFile !== "function") return ctx;
  if (sm.getSessionFile()) return ctx;
  const file = stateFileFor(sm.getSessionId?.());
  return { ...ctx, sessionManager: { ...sm, getSessionFile: () => file } };
}

const upstreamFactory = upstream.createAcpExtension();

function factory(pi) {
  const wrapped = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "on") {
        return (event, handler) =>
          target.on(event, (payload, ctx) => handler(payload, withSessionFile(ctx)));
      }
      if (key === "registerTool") {
        return (tool) =>
          target.registerTool({
            ...tool,
            execute: (id, params, signal, onUpdate, ctx) =>
              tool.execute(id, params, signal, onUpdate, withSessionFile(ctx)),
          });
      }
      if (key === "registerCommand") {
        return (name, options) =>
          target.registerCommand(name, {
            ...options,
            handler: (args, ctx) => options.handler(args, withSessionFile(ctx)),
          });
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return upstreamFactory(wrapped);
}

export default factory;
