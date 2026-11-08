import { spawn } from 'node:child_process';

// Callers can wrap the whole verification command in their own resource policy.
export function runNative(args, cwd) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native verification requires macOS and Xcode Command Line Tools'));
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Native verification command failed: ${signal || code}`)));
  });
}
