#!/usr/bin/env node
// 先启动 vite dev server，等到输出 "Local:" 后再拉起 electron（ROUTINE_DEV=1）

const { spawn } = require('child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const procs = [];
let shuttingDown = false;
let electronStarted = false;

function start(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ROUTINE_DEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  const tag = `[${name}] `;
  p.stdout.on('data', (d) => {
    const s = d.toString();
    process.stdout.write(tag + s);
    if (opts.onStdout) opts.onStdout(s);
  });
  p.stderr.on('data', (d) => process.stderr.write(tag + d.toString()));
  p.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${name} exited (code=${code})`);
      shutdown(code ?? 0);
    }
  });
  procs.push(p);
  return p;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('vite', 'npx', ['vite', '--config', 'vite.config.ts'], {
  onStdout(s) {
    if (s.includes('Local:') && !electronStarted) {
      electronStarted = true;
      setTimeout(() => start('electron', 'npx', ['electron', '.']), 600);
    }
  }
});
