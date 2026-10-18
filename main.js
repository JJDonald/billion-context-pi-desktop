"use strict";

/**
 * Billion Context — plugin process.
 *
 * The compression engine is the vendored billion-context-pi extension
 * (contributes.agentExtensions). That extension reads its configuration from
 * `~/.pi/acp.json`, not from PI-Desktop plugin settings, so this file bridges the
 * two: settings from the Plugins page are written into that file, and the panel
 * reads status back out of the state and log files the extension leaves behind.
 *
 * Nothing here compresses anything — it only configures and reports.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "acp-desktop");
const LOG_FILE = path.join(os.homedir(), ".pi", "acp.log");

function configPath() {
  return path.join(os.homedir(), ".pi", "acp.json");
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(next) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Settings -> acp.json. Only the keys this plugin owns are touched, so anything
 * hand-written in that file (compress.*, protectedTools, …) survives.
 */
async function syncConfigFromSettings() {
  const settings = await pi.plugin.getSettings();
  const config = readConfig();
  const next = { ...config, enabled: settings.enabled !== false };

  const limit = Number(settings.modelContextLimit);
  if (Number.isFinite(limit) && limit > 0) next.modelContextLimit = Math.round(limit);
  else delete next.modelContextLimit;

  if (JSON.stringify(next) !== JSON.stringify(config)) writeConfig(next);
  return next;
}

/** State files the extension writes, newest first. */
function listStateFiles() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((name) => name.endsWith(".acp.json"))
      .map((name) => {
        const file = path.join(STATE_DIR, name);
        const stat = fs.statSync(file);
        return { name, file, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/**
 * One state file. A missing or half-written file is reported as such rather than
 * thrown at the panel, because the extension writes these while a turn runs.
 */
function summarizeState(file) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { unreadable: String(err && err.message ? err.message : err) };
  }
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const stats = state.stats && typeof state.stats === "object" ? state.stats : {};
  const refs = state.messageRefs && state.messageRefs.byRef ? state.messageRefs.byRef : {};
  return {
    blocks: blocks
      .filter((block) => block.active)
      .map((block) => ({
        id: block.blockId,
        tier: block.tier,
        messages: Array.isArray(block.effectiveMessageIds) ? block.effectiveMessageIds.length : 0,
        summaryChars: String(block.summary || "").length,
        topic: block.topic || "",
      })),
    folds: Number(stats.compressionCount) || 0,
    reclaimed: Number(stats.tokensCompressed) || 0,
    tracked: Object.keys(refs).length,
  };
}

/** Tail of the extension's own log, compression lines only. */
function recentLog(limit) {
  let text;
  try {
    const stat = fs.statSync(LOG_FILE);
    const span = Math.min(stat.size, 128 * 1024);
    const handle = fs.openSync(LOG_FILE, "r");
    try {
      const buf = Buffer.alloc(span);
      fs.readSync(handle, buf, 0, span, stat.size - span);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => /\[compress\]|\[turn\]/i.test(line))
    .slice(-limit)
    .reverse()
    .map((line) => line.replace(/^[\d\-T:.]+Z\s*/, "").trim());
}

async function onLoad() {
  try {
    await syncConfigFromSettings();
  } catch (err) {
    await pi.ui.showToast(
      `Billion Context: could not write config — ${String(err && err.message ? err.message : err)}`,
    );
  }

  await pi.commands.register({
    id: "billion-context.open",
    title: "Billion Context: Context compression",
    keywords: ["context", "compress", "acp", "tokens", "压缩"],
    run: async () => {
      const current = listStateFiles()[0];
      if (!current) {
        await pi.ui.showToast("Billion Context: no folded ranges yet");
        return;
      }
      const summary = summarizeState(current.file);
      if (summary.unreadable) {
        await pi.ui.showToast(`Billion Context: state file unreadable — ${summary.unreadable}`);
        return;
      }
      await pi.ui.showToast(
        summary.blocks.length
          ? `${summary.blocks.length} folded range(s), ${summary.folds} fold(s), ~${summary.reclaimed} tokens reclaimed`
          : "Billion Context: nothing folded in the latest session",
      );
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void syncConfigFromSettings();
    });
  }
}

async function onUnload() {
  try {
    await pi.commands.unregister("billion-context.open");
  } catch {
    /* already gone */
  }
}

async function onPanelInvoke(channel) {
  if (channel === "status.get") {
    const config = readConfig();
    const files = listStateFiles();
    const current = files[0];
    return {
      enabled: config.enabled !== false,
      contextLimit: Number(config.modelContextLimit) || 0,
      stateDir: STATE_DIR,
      logFile: LOG_FILE,
      sessions: files.length,
      current: current
        ? { name: current.name, at: current.mtimeMs, ...summarizeState(current.file) }
        : undefined,
      log: recentLog(12),
    };
  }
  return { error: `unknown channel ${channel}` };
}

module.exports = { onLoad, onUnload, onPanelInvoke };
