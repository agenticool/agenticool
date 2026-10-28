// REST calls through @agenticool/github with the pacing and secondary rate
// limit retries that github-operations.md sets for writes.
import { execFileSync } from 'node:child_process';
import { githubError, ghRequest, ghRestPages } from '@agenticool/github';

export const CREATE_GAP = 3000;
export const WRITE_GAP = 1000;
export const RETRIES = 5;
const DEFAULT_WAIT = 60;
const SECONDARY = /secondary rate limit|abuse detection/i;

/**
 * @typedef {{
 *   run?: import('@agenticool/github').Run,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 * }} ClientOptions
 * @typedef {ReturnType<typeof restClient>} Client
 */

/** @param {ClientOptions} options */
export function restClient({ run = execFileSync, sleep, now }) {
  let lastWrite = -Infinity;
  let lastCreate = -Infinity;
  return {
    /**
     * One read; returns the parsed body.
     * @param {string} path
     * @returns {any}
     */
    read(path) {
      const response = ghRequest('REST', [path], { run });
      if (response.failed) throw githubError('REST', response);
      return response.body;
    },
    /**
     * Every page of a list, flattened.
     * @param {string} path
     * @returns {any[]}
     */
    pages: (path) => ghRestPages(path, { run }).flat(),
    /**
     * One write, at least 3 seconds after the last create when it is a create
     * and 1 second after any other write. A secondary rate limit waits
     * `retry-after` seconds, or 60 without one, doubling on each further
     * limit, and fails after five retries.
     * @param {string[]} args
     * @param {{ create?: boolean }} [options]
     * @returns {Promise<any>}
     */
    async write(args, { create = false } = {}) {
      for (let attempt = 0; ; attempt++) {
        const ready = Math.max(
          lastWrite + WRITE_GAP,
          create ? lastCreate + CREATE_GAP : -Infinity,
        );
        if (ready > now()) await sleep(ready - now());
        const response = ghRequest('REST', args, { run });
        lastWrite = now();
        if (create) lastCreate = lastWrite;
        if (!response.failed) return response.body;
        const secondary =
          (response.status === 403 || response.status === 429) &&
          SECONDARY.test(String(response.body?.message ?? ''));
        if (!secondary || attempt === RETRIES)
          throw githubError('REST', response);
        const header = response.headers['retry-after'];
        const wait = /^\d+$/.test(header ?? '') ? Number(header) : DEFAULT_WAIT;
        await sleep(wait * 1000 * 2 ** attempt);
      }
    },
  };
}
