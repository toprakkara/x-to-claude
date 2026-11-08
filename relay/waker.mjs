// Runs the archivist in the background, with no window, for posts that reach the queue while it's closed:
// `claude -p` processes the queue in the archive folder and exits. No long-lived session or open tab is needed.
// - Runs when pendingIds() isn't empty and isArchivistAlive() is false; args(ids) builds the command line.
// - Rapid requests collapse into one wake-up within debounceMs; a request during a run triggers one more run afterwards.
// - After a failed run there are no wake-ups for retryMs, so it can't loop and burn usage.
// - The process is killed after timeoutMs.
// - In a folder that isn't trusted, Claude Code ignores the archivist's permissions, so a run writes nothing yet exits 0.
//   Retrying can't help and each run costs usage, so wake-ups stop until retryNow or a relay restart.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

const UNTRUSTED = /has not been trusted/;

// The pending IDs go in the message, so the archivist doesn't have to scan the library for posts without notes.
export function wakePrompt(ids) {
  return [
    '[x-to-claude] WAKE-UP: Posts reached the archive queue while the archivist session was closed, so the relay started you in the background.',
    `Queued posts with no library note yet (in inbox/queue.jsonl, by ID): ${ids.join(', ')}.`,
    'Classify them following CLAUDE.md: write a plan file, run the note writer and add a line to log.md.',
    'Do not send notices; the relay already did.',
    'This is a background run: ask no questions and take on nothing that needs the user\'s approval, such as splitting a category.',
    'When you finish, summarize what you did in two or three lines and exit.',
  ].join(' ');
}

export function createWaker({
  cwd,
  command,
  args,
  env,
  pendingIds,
  isArchivistAlive,
  logFile,
  debounceMs = 10_000,
  timeoutMs = 15 * 60_000,
  retryMs = 30 * 60_000,
  spawn = nodeSpawn,
  now = Date.now,
}) {
  let timer = null;
  let child = null;
  let again = false;
  let blockedUntil = 0;
  const runs = [];

  const log = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()} ${line}\n`);
    } catch {}
  };

  function start(reason) {
    timer = null;
    const ids = pendingIds();
    if (!ids.length) return;
    if (isArchivistAlive()) return log(`no wake-up needed: archivist is open (${reason})`);
    if (now() < blockedUntil) return log(`wake-up postponed: the previous run failed (${reason})`);

    log(`waking: ${ids.length} pending (${reason})`);
    const startedAt = now();
    child = spawn(command, typeof args === 'function' ? args(ids) : args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    const kill = setTimeout(() => child?.kill('SIGTERM'), timeoutMs);
    kill.unref?.(); // the timeout timer must not keep the relay (or a test) from exiting
    let finished = false;
    const finish = (code) => {
      if (finished) return; // a spawn failure can emit both 'error' and 'close'
      finished = true;
      clearTimeout(kill);
      child = null;
      const untrusted = UNTRUSTED.test(out);
      const ok = code === 0 && !untrusted;
      runs.push({ startedAt, ok, code });
      log(`archivist finished: exit ${code}, ${Math.round((now() - startedAt) / 1000)} s${out.trim() ? `\n  ${out.trim().split('\n').slice(-6).join('\n  ')}` : ''}`);
      if (untrusted) {
        blockedUntil = Infinity;
        log('the archive folder is not trusted, so the archivist cannot write notes. Wake-ups are off until you start claude there once, accept the trust dialog and restart the relay.');
      } else if (!ok) blockedUntil = now() + retryMs;
      if (again && ok) {
        again = false;
        request('save during run');
      }
    };
    child.on('error', (e) => {
      out += `could not start: ${e.message}`;
      finish(-1);
    });
    child.on('close', finish);
  }

  function request(reason = 'save') {
    if (child) {
      again = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => start(reason), debounceMs);
  }

  // When the cause of a failure is gone (the Claude login was renewed), retries without waiting out the block.
  function retryNow(reason) {
    blockedUntil = 0;
    request(reason);
  }

  return {
    request,
    retryNow,
    get running() {
      return !!child;
    },
    runs,
  };
}
