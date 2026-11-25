import { homedir } from 'node:os';
import { join } from 'node:path';

const WEEK_MINUTES = 7 * 24 * 60;
const MAX_OUTPUT = 256 * 1024;
const GRACE_MS = 1_000;
const WSL_CLAUDE = 'exec "$HOME/.local/bin/claude" "$@"';
const CLAUDE_ENV = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '0',
  CLAUDE_CODE_NO_FLICKER: '0',
};
const CLAUDE_ARGS = [
  '--setting-sources', '',
  '--settings', '{"disableAllHooks":true,"autoInstallIdeExtension":false}',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome', '--tools', '', '--prompt-suggestions', 'off',
];

export function parseCodexWeekly(response) {
  const limits = response?.rateLimitsByLimitId;
  const bucket = limits == null
    ? (response?.rateLimits?.limitId === 'codex' ? response.rateLimits : null)
    : (Object.hasOwn(limits, 'codex') ? limits.codex : null);
  const matching = [bucket?.primary, bucket?.secondary].filter(window => window?.windowDurationMins === WEEK_MINUTES);
  if (matching.length !== 1) return { status: 'no-data' };
  const { usedPercent, resetsAt } = matching[0];
  if (!validPercent(usedPercent)) return { status: 'error' };
  return {
    status: 'ready', remainingPercent: 100 - usedPercent,
    ...(Number.isSafeInteger(resetsAt) && resetsAt > 0 && resetsAt <= 8.64e12 ? { resetsAt: resetsAt * 1000 } : {}),
  };
}

function validPercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function cleanTerminal(data) {
  return data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_, count) => ' '.repeat(Math.min(Number(count) || 1, 120)))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u00a0/g, ' ');
}

export function parseClaudeWeekly(text) {
  const title = [...text.matchAll(/Current\s*week\s*\(\s*all\s*models\s*\)/gi)].at(-1);
  if (!title) return null;
  const tail = text.slice(title.index + title[0].length, title.index + title[0].length + 320);
  // Stop before a different window or credit; its percentage does not belong to this window.
  const block = tail.split(/Current\s*(?:week|session)|Extra\s*usage|Usage\s*credits|Resets\b/i, 1)[0];
  const used = /(?:^|[^\d.-])(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i.exec(block);
  return used && validPercent(Number(used[1]))
    ? { status: 'ready', remainingPercent: Math.round((100 - Number(used[1])) * 100) / 100 } : null;
}

// Onboarding and trust screens can use the same arrow as the real input box.
export function claudePromptState(text) {
  if (/trust\s*this\s*folder|quick\s*safety\s*check|ANSI\s*colors\s*only|choose\s*the\s*text\s*style|select\s*login\s*method|No,\s*exit/i.test(text)) return 'setup';
  if (/─{25,}\s*❯\s*─{25,}/u.test(text)) return 'ready';
  return 'waiting';
}

function observeText(stream, done, signal, visit) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const ended = () => finish({ status: 'error' });
    const aborted = () => finish(undefined, signal.reason);
    const data = chunk => {
      try {
        const result = visit(chunk);
        if (result) finish(result);
      } catch (error) { finish(undefined, error); }
    };
    function finish(result, error) {
      stream.off('data', data);
      stream.off('end', ended);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(result);
    }
    stream.setEncoding('utf8');
    stream.on('error', ended);
    stream.on('end', ended);
    stream.on('data', data);
    signal.addEventListener('abort', aborted, { once: true });
    void done.catch(ended);
  });
}

async function resolveCli(subprocess, program, signal) {
  const windows = process.platform === 'win32';
  const name = windows ? `${program}.exe` : program;
  const appData = process.env.APPDATA;
  const target = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const npmFallback = appData && (program === 'codex'
    ? join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      `codex-win32-${process.arch}`, 'vendor', `${target}-pc-windows-msvc`, 'bin', name)
    : join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name));
  for (const candidate of [name, ...(windows && npmFallback ? [npmFallback] : [])]) {
    try { return await subprocess.resolveExecutable(candidate, undefined, signal); }
    catch (error) {
      if (error?.code !== 'SUBPROCESS_EXECUTABLE_NOT_FOUND') throw error;
    }
  }
  return null;
}

export async function readCodex(subprocess, signal) {
  if (!subprocess) return { status: 'no-data' };
  const executable = await resolveCli(subprocess, 'codex', signal);
  if (!executable) return { status: 'not-installed' };
  const handle = subprocess.spawn({
    argv: [executable, '-c', 'analytics.enabled=false', 'app-server', '--stdio'],
    cwd: homedir(), graceMs: GRACE_MS, signal,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
  });
  let initialized = false;
  let buffer = '';
  const send = message => { handle.stdin.write(`${JSON.stringify(message)}\n`); };
  try {
    handle.stdin.on('error', () => {});
    const result = observeText(handle.stdout, handle.done, signal, chunk => {
      buffer += chunk;
      if (buffer.length > MAX_OUTPUT) return { status: 'error' };
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (!initialized && message.id === 1) {
          if (!message.result) return { status: 'error' };
          initialized = true;
          send({ method: 'initialized' });
          send({ method: 'account/rateLimits/read', id: 2 });
        } else if (initialized && message.id === 2) {
          const failure = message.error?.message;
          if (typeof failure === 'string') {
            if (/only.*ChatGPT|without.*ChatGPT|API key/i.test(failure)) return { status: 'no-data' };
            if (/not (?:logged|authenticated)|authentication (?:required|unavailable)|unauthorized|401|log ?in|sign ?in/i.test(failure)) return { status: 'sign-in' };
            return { status: 'error' };
          }
          return parseCodexWeekly(message.result);
        }
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'dsh_credit_usage', version: '0.1.0' } } });
    return await result;
  } finally {
    handle.stdin?.end();
    handle.terminate();
    const exited = await handle.waitForExit(AbortSignal.timeout(3_000));
    if (!exited) throw new Error('Codex subprocess cleanup timed out');
  }
}

export async function readClaude(subprocess, config, signal) {
  if (!subprocess) return { status: 'no-data' };
  const { claudeWslCwd, claudeWslDistro, claudeCwd } = config;
  let argv;
  if (process.platform === 'win32' && claudeWslCwd) {
    if (typeof claudeWslCwd !== 'string' || !claudeWslCwd.startsWith('/') || /[\x00-\x1f]/.test(claudeWslCwd)) return { status: 'setup' };
    const wsl = await subprocess.resolveExecutable('wsl.exe', undefined, signal);
    argv = [wsl, ...(claudeWslDistro ? ['-d', claudeWslDistro] : []), '--cd', claudeWslCwd, '--exec',
      '/usr/bin/env', '-u', 'CLAUDECODE', ...Object.entries(CLAUDE_ENV).map(([key, value]) => `${key}=${value}`),
      '/bin/sh', '-c', WSL_CLAUDE, 'dsh-credit-usage', ...CLAUDE_ARGS];
  } else {
    const executable = await resolveCli(subprocess, 'claude', signal);
    if (!executable) return { status: 'not-installed' };
    argv = [executable, ...CLAUDE_ARGS];
  }
  const terminal = await subprocess.spawnTerminal({
    argv, cwd: claudeCwd || homedir(), cols: 110, rows: 42, terminalType: 'xterm-256color',
    env: CLAUDE_ENV, graceMs: GRACE_MS, signal,
  });
  let buffer = '';
  let sent = false;
  try {
    return await observeText(terminal.output, terminal.done, signal, chunk => {
      buffer = (buffer + chunk).slice(-MAX_OUTPUT);
      const text = cleanTerminal(buffer);
      if (!sent) {
        const state = claudePromptState(text);
        if (state === 'setup') return { status: 'setup' };
        if (state === 'ready') {
          buffer = '';
          sent = true;
          return writeUsage();
        }
        return undefined;
      }
      if (/(?:Couldn['’]t|Failed\s*to|Unable\s*to)\s*(?:load|fetch)\s*usage/i.test(text)) return { status: 'error' };
      return parseClaudeWeekly(text);
    });
  } finally {
    await terminal.terminate();
  }

  function writeUsage() {
    // A write fault must settle as a read failure, never prompt retry with another input.
    void terminal.write('/usage\r').catch(() => { void terminal.terminate().catch(() => {}); });
  }
}
