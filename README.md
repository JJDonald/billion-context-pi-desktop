# Billion Context for PI-Desktop

Model-driven context compression, ported from
[`billion-context`](https://github.com/ranxianglei/billion-context) /
[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi).

The model writes the summaries itself and folds old ranges into them, so one
session keeps going instead of dying at the context window. The transcript stays
lossless; only what goes to the model is folded.

## What the agent gets

| Tool | Purpose |
|---|---|
| `compress` | Fold a message range into a summary the model writes |
| `decompress` | Restore a folded range when exact detail is needed again |
| `search_context` | Keyword search over summaries and visible messages |
| `acp_status` | Context usage, and which ranges are still compressible |
| `acp_cache` | Cache / attribution view |

Plus `/acp*` slash commands (`/acp-status`, `/acp-cache`, `/acp-rule`,
`/acp-export`, `/acp-decompress`, `/acp-search`, …). Every user message gains an
`<acp tokens="…">mNNNNN</acp>` tag for the model's eye; PI-Desktop's transcript
does not show it.

## What this port adds

The upstream package runs **unmodified**; this plugin supplies the two host
expectations it cannot find on its own, in `extension/entry.mjs`.

**1. Host recognition.** Upstream requires
`sessionManager.buildContextEntries()` and otherwise treats the host as
unsupported and refuses to compress. PI-Desktop is a Pi-compatible fork exposing
`getBranch()`, so the adapter declares it with `PI_ACP_FORK_HOST=1` — the
declaration upstream documents for forks.

**2. Durable fold state.** Upstream keys compression state off
`sessionManager.getSessionFile()`. PI-Desktop exposes no session log path, so
every fold was lost on quit. The adapter answers that call with a stable
per-session path under `~/.pi/agent/acp-desktop/`, and upstream writes and
reloads its own sidecar there. It wraps all three places a context reaches an
extension — event handlers, tool `execute`, and command `handler` — because
upstream persists from each of them.

Everything else is upstream. The vendored copy is pinned and upstream's
self-update stays off (it would `npm install` over files inside the installed
plugin); fixes arrive by re-vendoring:

```bash
npm pack billion-context-pi@<version>
rm -rf vendor/billion-context-pi && mkdir -p vendor/billion-context-pi
tar xzf billion-context-pi-<version>.tgz -C /tmp \
  && cp -r /tmp/package/{dist,schema,package.json,LICENSE} vendor/billion-context-pi/
```

## Panel and settings

The **Context compression** view shows the current session's active folds,
reclaimed tokens, tracked messages, the resolved config, and the tail of the
extension's own log.

Both settings are written into `~/.pi/acp.json` by `main.js`, because that is
where the extension actually reads configuration:

| Setting | Effect |
|---|---|
| Enable compression | `enabled` — off leaves PI-Desktop's native context management in control |
| Context limit override | `modelContextLimit` — 0 uses the model's own window |

Only those two keys are touched; anything you write into `acp.json` by hand is
preserved. Full key list:
[CONFIGURATION.md](https://github.com/ranxianglei/billion-context/blob/master/CONFIGURATION.md).

## Install

Plugins → install from folder → pick this directory. Grant `agent.extension`
(the extension runs with the same trust as the agent). Start a session;
`acp_status` should report `host=billion-context-pi`.

## Known gaps on PI-Desktop

Upstream features with no host equivalent here. Each reports an
`unsupported_api` diagnostic and is otherwise inert — nothing breaks.

| Gap | Effect |
|---|---|
| `event "input"` not emitted | No interception of typed prompts before they are sent |
| `registerEntryRenderer` unavailable | Compression entries are not specially rendered in the transcript |
| `registerShortcut` unavailable | No keyboard shortcut for the `/acp` commands |
| Sub-agent surface | Upstream's `acp_delegate*` tools need a Pi session API PI-Desktop does not expose, so they stay off. Use PI-Desktop's own `SessionTask` instead. |

## Layout

```
manifest.json                 manifest (agentExtensions + views + settings)
main.js                       settings → acp.json, panel queries, /billion-context.open
extension/entry.mjs           host recognition + durable fold state
views/status.html             the Context compression panel
vendor/billion-context-pi/    billion-context-pi@0.1.83, MIT, unmodified
```

## License

Upstream `billion-context-pi` is MIT; its `LICENSE` is kept in
`vendor/billion-context-pi/`.
