// Vibe provider installation (ProviderInstallation): inspect (vibe
// --version), checkForUpdates (PyPI `info.version` vs installed) and
// update (uv tool upgrade, output streamed to `report`). The CLI is managed
// by uv (`uv tool install mistral-vibe`); PyPI is the source of truth for
// published versions.

import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  ProviderInspection,
  ProviderInstallation,
  ProviderUpdateCheck,
  ProviderUpdateCheckContext,
  ProviderUpdateContext,
  ProviderUpdateResult,
} from "@getpaseo/plugin/server/provider";
import { vibeEnv } from "./connection";

/** Network: short — an update check must never hang the UI. */
const PYPI_TIMEOUT_MS = 10_000;
/** Safety margin: `uv tool upgrade` takes ~30 s at worst; wide margin. */
const UPDATE_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compares two decimal versions (PEP 440-light): negative if a < b.
 * Non-numeric segments (canon "3.1.4b1", build): lexicographic order.
 * Missing segments open as empty: "3.1.4" is greater than "3.1".
 */
function compareVersions(a: string, b: string): number {
  const sa = a.split(".");
  const sb = b.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const left = Number(sa[i]);
    const right = Number(sb[i]);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      const order = String(sa[i] ?? "").localeCompare(String(sb[i] ?? ""));
      if (order !== 0) return order;
      continue;
    }
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Installed version: `vibe --version` (same channel as the provider inspect). */
export async function inspectVibe(signal: AbortSignal): Promise<ProviderInspection> {
  try {
    const { stdout } = await execCommand("vibe", ["--version"], { signal, timeout: 15_000, env: vibeEnv() });
    const version = stdout.trim().match(/vibe\s+(\d[^\s]*)/i)?.[1];
    return { status: "installed", ...(version ? { version } : {}) };
  } catch {
    return { status: "not_installed" };
  }
}

/** Latest version published on PyPI (JSON API, `info.version` field). */
async function latestPypiVersion(signal: AbortSignal): Promise<string> {
  const response = await fetch("https://pypi.org/pypi/mistral-vibe/json", {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(PYPI_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw new Error(`PyPI answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  }
  const json = (await response.json()) as { info?: { version?: unknown } };
  const version = json?.info?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("PyPI response carries no info.version");
  }
  return version.trim();
}

async function checkVibeUpdates({ signal, installedVersion }: ProviderUpdateCheckContext): Promise<ProviderUpdateCheck> {
  // installedVersion absent (inspect without a version, or provider without
  // inspect): we rerun the detection ourselves, same channel as the inspect.
  const inspect = await inspectVibe(signal);
  const installed = installedVersion ?? (inspect.status === "installed" ? inspect.version : undefined);
  if (!installed) {
    return { status: "unknown", message: "vibe is not installed or reported no version; cannot compare against PyPI" };
  }
  let latest: string;
  try {
    latest = await latestPypiVersion(signal);
  } catch (error) {
    return { status: "unknown", message: `cannot read the latest mistral-vibe version on PyPI: ${errorMessage(error)}` };
  }
  return compareVersions(latest, installed) > 0 ? { status: "available", versions: [latest] } : { status: "current" };
}

async function updateVibe({ signal, report }: ProviderUpdateContext): Promise<ProviderUpdateResult> {
  const before = await inspectVibe(signal);
  // Important caveat: uv replaces the tool's venv; vibe processes already
  // spawned by the daemon keep running the old version until they die.
  console.warn(
    "[vibe-provider] update: `uv tool upgrade` replaces the shared tool venv — already-running vibe sessions keep the old version until they exit",
  );
  report({ type: "message", text: "uv tool upgrade mistral-vibe" });
  const child = spawnProcess("uv", ["tool", "upgrade", "mistral-vibe"], { stdio: "pipe", env: vibeEnv(), signal });
  let stdoutTail = "";
  let stderrTail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutTail = (stdoutTail + chunk).slice(-2_000);
    report({ type: "stdout", text: chunk });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
    report({ type: "stderr", text: chunk });
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void terminateProcess(child);
  }, UPDATE_TIMEOUT_MS);
  const outcome = await new Promise<{ exitCode: number | null; error: Error | null }>((resolve) => {
    child.once("exit", (exitCode) => resolve({ exitCode, error: null }));
    child.once("error", (error) => resolve({ exitCode: null, error }));
  });
  clearTimeout(watchdog);
  if (timedOut) {
    return { status: "failed", message: `uv tool upgrade did not complete within ${UPDATE_TIMEOUT_MS / 1_000} s` };
  }
  if (signal.aborted) {
    return { status: "failed", message: "update aborted before completion" };
  }
  if (outcome.error) {
    return { status: "failed", message: `uv tool upgrade could not start: ${outcome.error.message}` };
  }
  if (outcome.exitCode !== 0) {
    const detail = (stderrTail || stdoutTail).trim();
    return { status: "failed", message: `uv tool upgrade exited with code ${outcome.exitCode}${detail ? `: ${detail}` : ""}` };
  }
  const after = await inspectVibe(signal);
  const from = before.status === "installed" ? before.version : undefined;
  const to = after.status === "installed" ? after.version : undefined;
  if (to && from && to !== from) return { status: "succeeded", message: `mistral-vibe ${from} → ${to}` };
  if (to) return { status: "succeeded", message: `mistral-vibe ${to} (already the latest PyPI release)` };
  return { status: "succeeded", message: "uv tool upgrade mistral-vibe completed" };
}

export function createVibeInstallation(): ProviderInstallation {
  return {
    installUrl: "https://github.com/mistralai/mistral-vibe#readme",
    updateUrl: "https://pypi.org/project/mistral-vibe",
    inspect: async ({ signal }) => inspectVibe(signal),
    checkForUpdates: checkVibeUpdates,
    update: updateVibe,
  };
}
