/**
 * Spawns the worker processes for the concurrency suite and collects what they
 * report back.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerConfig, WorkerResult } from './worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.ts');
const PROJECT_ROOT = resolve(HERE, '..', '..');

export interface SpawnedResult {
  result?: WorkerResult;
  error?: { message: string; stack?: string };
  code: number | null;
  stderr: string;
}

/**
 * Run one worker. The config goes through a file rather than argv because
 * Windows has a hard limit on command-line length and these configs carry paths.
 */
export function runWorkerProcess(config: WorkerConfig, configDir: string, index: number): Promise<SpawnedResult> {
  const configPath = join(configDir, `worker-${index}.json`);
  writeFileSync(configPath, JSON.stringify(config), 'utf8');

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, `@${configPath}`], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    child.on('close', (code) => {
      const resultAt = stdout.indexOf('__RESULT__');
      const errorAt = stdout.indexOf('__ERROR__');
      if (resultAt >= 0) {
        resolvePromise({ result: JSON.parse(stdout.slice(resultAt + '__RESULT__'.length)), code, stderr });
      } else if (errorAt >= 0) {
        resolvePromise({ error: JSON.parse(stdout.slice(errorAt + '__ERROR__'.length)), code, stderr });
      } else {
        resolvePromise({ error: { message: `Worker produced no result. stderr: ${stderr}` }, code, stderr });
      }
    });
  });
}

/** Run several workers at once and wait for all of them. */
export async function runWorkers(configs: WorkerConfig[], configDir: string): Promise<SpawnedResult[]> {
  return Promise.all(configs.map((config, index) => runWorkerProcess(config, configDir, index)));
}

/** Assert every worker finished cleanly, with a readable message if not. */
export function expectAllSucceeded(results: SpawnedResult[]): WorkerResult[] {
  const failures = results.filter((result) => !result.result);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} worker(s) failed:\n` +
        failures.map((f) => `  exit ${f.code}: ${f.error?.message}\n${f.error?.stack ?? f.stderr}`).join('\n'),
    );
  }
  return results.map((result) => result.result!);
}
