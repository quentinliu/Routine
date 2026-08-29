import { execFile } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 15000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          code = typeof e.code === 'number' ? e.code : 1;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      }
    );
  });
}
