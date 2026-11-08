// The Claude CLI login. The `claude -p` processes the relay starts (new sessions, waking the archivist) use the CLI's own
// login. Desktop sessions manage theirs separately, so when the CLI login expires Desktop keeps working and these stop.
//   status()  `claude auth status`: { loggedIn: true | false | null (unknown), running }
//   start()   `claude auth login`: opens the sign-in page in the browser and waits for the callback; no terminal needed.
//             If one is already running, it's replaced: the user may have closed the page.
// The commands are fixed and take no outside arguments.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

// The messages come from the Claude Code 2.1.290 and 2.1.317 binaries. Callers check only on a non-zero exit, and only the
// end of the output is searched, because a post or Claude's reply could contain the same words.
const LOGIN_FAILURE = /failed to authenticate|not logged in|please run \/login/i;
export const isLoginFailure = (output) => LOGIN_FAILURE.test((output ?? '').slice(-500));

export function createClaudeLogin({ claudePath, env, cwd, logFile, onLogin = () => {}, spawn = nodeSpawn, timeoutMs = 5 * 60_000 }) {
  let child = null;

  const log = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };

  function status() {
    if (child) return Promise.resolve({ loggedIn: false, running: true });
    return new Promise((resolve) => {
      let out = '';
      const p = spawn(claudePath, ['auth', 'status'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => p.kill('SIGTERM'), 15_000);
      timer.unref?.();
      p.stdout?.on('data', (d) => (out += d));
      const finish = () => {
        clearTimeout(timer);
        let loggedIn = null;
        try {
          const value = JSON.parse(out).loggedIn;
          if (typeof value === 'boolean') loggedIn = value;
        } catch {}
        resolve({ loggedIn, running: false });
      };
      p.on('error', finish);
      p.on('close', finish);
    });
  }

  function start() {
    child?.kill('SIGTERM');
    let out = '';
    let finished = false;
    const p = spawn(claudePath, ['auth', 'login'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = p;
    log('login started');
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    timer.unref?.();
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (out += d));
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child === p) child = null;
      if (code === 0) {
        log('login completed');
        onLogin();
      } else {
        // The query part of the sign-in link (state, code_challenge) stays out of the log.
        log(`login not completed: exit ${code}: ${out.replace(/\?\S*/g, '?…').trim().slice(-200)}`);
      }
    };
    p.on('error', (e) => {
      out += e.message;
      finish(-1);
    });
    p.on('close', finish);
  }

  return { status, start };
}
