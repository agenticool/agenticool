// Package labels for the release pull request, used only when the policy
// turns on `binding.features.releasePlease`.
import { repository } from '@agenticool/core';

/**
 * @typedef {import('./core.mjs').Api} Api
 * @typedef {import('./core.mjs').Policy} Policy
 */

// Release Please opens one rolling release PR from this branch of the
// repository itself; its body links every changelog entry.
export const RELEASE_BRANCH = 'release-please--branches--main';

/** @param {{ headRefName?: string, isCrossRepository?: boolean }} pr */
export function isReleasePullRequest(pr) {
  return pr.headRefName === RELEASE_BRANCH && pr.isCrossRepository === false;
}

// Components whose version differs between two parsed manifests, in
// release-please-config.json order.
/**
 * @param {any} config
 * @param {Record<string, string> | undefined} base
 * @param {Record<string, string> | undefined} head
 * @returns {string[]}
 */
export function releasedComponents(config, base, head) {
  return Object.entries(config?.packages ?? {})
    .filter(
      ([path, settings]) =>
        settings?.component &&
        head?.[path] !== undefined &&
        head[path] !== base?.[path],
    )
    .map(([, settings]) => settings.component);
}

// The release PR gets one `package:` label per package whose version it
// changes. The component mapping comes from the base commit; the manifest is
// compared between the base and head commits.
/**
 * @param {Api} api
 * @param {Policy} policy
 * @param {{ baseRefOid: string, headRefOid: string }} pr
 * @param {(message: string) => void} log
 * @returns {Promise<string[]>} label IDs
 */
export async function releaseLabels(api, policy, pr, log) {
  const [owner, name] = repository(policy).split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $config: String!, $base: String!, $head: String!) {
      repository(owner: $owner, name: $name) {
        config: object(expression: $config) { ... on Blob { text } }
        base: object(expression: $base) { ... on Blob { text } }
        head: object(expression: $head) { ... on Blob { text } }
      }
    }`,
    {
      owner,
      name,
      config: `${pr.baseRefOid}:release-please-config.json`,
      base: `${pr.baseRefOid}:.release-please-manifest.json`,
      head: `${pr.headRefOid}:.release-please-manifest.json`,
    },
  );
  /** @param {{ text?: string } | null | undefined} blob */
  const parse = (blob) => (blob?.text ? JSON.parse(blob.text) : {});
  const components = releasedComponents(
    parse(data.repository?.config),
    parse(data.repository?.base),
    parse(data.repository?.head),
  );
  log(
    `Release PR releases ${components.length ? components.join(', ') : 'no packages'}; issue labels are not copied.`,
  );
  /** @type {string[]} */
  const labels = [];
  for (const component of components) {
    const result = await api(
      `query($owner: String!, $name: String!, $label: String!) {
        repository(owner: $owner, name: $name) { label(name: $label) { id } }
      }`,
      { owner, name, label: `package: ${component}` },
    );
    const id = result.repository?.label?.id;
    if (id) labels.push(id);
    else log(`Label "package: ${component}" does not exist; skipping it.`);
  }
  return labels;
}
