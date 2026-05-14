import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function resolveHostPath(input: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

// ---------------------------------------------------------------------------
// Sandbox mounts
// ---------------------------------------------------------------------------

export const sandboxMounts =
  process.env.SANDCASTLE_NO_PI_MOUNT === '1'
    ? ([] as const)
    : [
        {
          hostPath: '~/.pi/agent' as const,
          sandboxPath: '~/.pi/agent' as const,
          readonly: false as const,
        },
      ];

if (sandboxMounts.length > 0 && !fs.existsSync(resolveHostPath('~/.pi/agent'))) {
  throw new Error(
    'The ~/.pi/agent directory is missing. Sandcastle mounts this directory into each sandbox so agents can access skills, settings, and sessions. Either create the directory or set SANDCASTLE_NO_PI_MOUNT=1 to skip the mount.',
  );
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

// In rootless Docker, the container UID 1000 maps to a different host UID,
// so bind-mounted ~/.pi/agent files are unreadable. Pass the opencode-go
// API key via env so pi can authenticate without reading auth.json.
export function readOpencodeApiKey(
  authPath: string = resolveHostPath('~/.pi/agent/auth.json'),
): string | undefined {
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    return auth['opencode-go']?.key;
  } catch {
    return undefined;
  }
}

const opencodeApiKey = readOpencodeApiKey();

export const sandboxProvider = docker({
  mounts: sandboxMounts,
  env: opencodeApiKey ? { OPENCODE_API_KEY: opencodeApiKey } : undefined,
});

// ---------------------------------------------------------------------------
// Orchestration constants
// ---------------------------------------------------------------------------

// How long to allow for graceful shutdown after SIGTERM before force-exit.
export const GRACEFUL_SHUTDOWN_MS = 10 * 60 * 1000;

// Maximum number of bead tasks to run in parallel during Phase 2.
// Default: 3. Override with SANDCASTLE_MAX_PARALLEL env var.
export const MAX_PARALLEL_TASKS = Number(process.env.SANDCASTLE_MAX_PARALLEL ?? '3');

// How long to sleep between polls for new open issues (milliseconds).
// Default: 5 minutes. Override with SANDCASTLE_POLL_MS env var.
export const POLL_INTERVAL_MS = Number(process.env.SANDCASTLE_POLL_MS ?? '300000');

// ---------------------------------------------------------------------------
// Sandbox hooks
// ---------------------------------------------------------------------------

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
export const hooks = {
  sandbox: { onSandboxReady: [{ command: 'CI=true pnpm install' }] },
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

// Logger: pretty-print when stdout is a TTY, raw JSON otherwise (systemd).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Worktree copy list
// ---------------------------------------------------------------------------

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
// .beads is included so the planner can query issues via `bd` inside the sandbox.
export const copyToWorktree = ['node_modules', '.pnpm-store', '.beads'];
