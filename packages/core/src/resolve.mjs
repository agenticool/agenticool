// `resolve` turns a role (or capability) plus optional prompt overrides into
// the exact model and effort a dispatcher must pass when it spawns an agent,
// and refuses unsupported values instead of letting a runtime substitute one.

/** @typedef {import('./policy.mjs').Policy} Policy */

export const TOOLS = ['claude', 'codex'];

/**
 * @param {Policy} policy
 * @param {string} tool
 * @param {string} model
 * @returns {string[] | null}
 */
function supportedEfforts(policy, tool, model) {
  const supported = policy.supported[tool];
  if (supported.models[model]) return supported.models[model];
  if (
    supported.modelIdPattern &&
    new RegExp(supported.modelIdPattern).test(model)
  )
    return supported.models[Object.keys(supported.models)[0]];
  return null;
}

// Prompt overrides win over the policy, one setting at a time. Anything the
// repository does not list is an error, never a fallback.
/**
 * @param {Policy} policy
 * @param {{ tool?: string, role?: string, capability?: string, model?: string, effort?: string }} [request]
 */
export function resolve(
  policy,
  { tool, role, capability, model, effort } = {},
) {
  if (!tool || !TOOLS.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  if (role && !policy.roles[role]) throw new Error(`Unknown role: ${role}`);
  const capabilityName = capability ?? (role ? policy.roles[role] : undefined);
  const entry = policy.capabilities[capabilityName];
  if (!entry) throw new Error(`Unknown capability: ${capabilityName}`);
  const defaults = entry[tool];
  const resolved = {
    tool,
    role: role ?? null,
    capability: capabilityName,
    model: model ?? defaults.model,
    effort: effort ?? defaults.effort,
    source: {
      model: model ? 'override' : 'policy',
      effort: effort ? 'override' : 'policy',
    },
  };
  const efforts = supportedEfforts(policy, tool, resolved.model);
  if (!efforts)
    throw new Error(
      `Unsupported ${tool} model "${resolved.model}". Supported: ${Object.keys(policy.supported[tool].models).join(', ')}.`,
    );
  if (!efforts.includes(resolved.effort))
    throw new Error(
      `Unsupported ${tool} effort "${resolved.effort}" for model "${resolved.model}". Supported: ${efforts.join(', ')}.`,
    );
  const agent = role ?? null;
  const spawn =
    tool === 'claude'
      ? {
          subagent_type: agent,
          model: resolved.model,
          effort: resolved.effort,
        }
      : {
          agent_type: agent,
          model: resolved.model,
          reasoning_effort: resolved.effort,
          fork_turns: 'none',
        };
  return { ...resolved, spawn };
}

// Recorded effort assessments contain evidence, never a score derived from labels.
/**
 * @param {Policy} policy
 * @param {{ decision?: Record<string, any>, transitions?: number }} [state]
 * @returns {Record<string, any>}
 */
export function implementationEffort(
  policy,
  { decision, transitions = 0 } = {},
) {
  const rubric = policy.implementationEffort;
  const ordinary = {
    effort: rubric.default,
    rule: 'default',
    evidence: 'ticket/spec',
    reason: 'The written plan resolves the design.',
  };
  if (!decision) return ordinary;
  if (decision.rule === 'user override') {
    if (
      !decision.evidence?.trim() ||
      !decision.reason?.trim() ||
      !decision.effort
    )
      throw new Error(
        'An effort override record needs effort, evidence, and reason',
      );
    return { ...decision };
  }
  const rule = rubric.rules[decision.rule];
  if (!rule || decision.effort !== rubric.automaticMaximum) return ordinary;
  if (
    !decision.evidence?.trim() ||
    !decision.reason?.trim() ||
    !decision.question?.trim()
  )
    return ordinary;
  if (
    !rule.requires.every(
      (/** @type {string} */ key) => decision.criteria?.[key] === true,
    )
  )
    return ordinary;
  if (decision.later && transitions >= rubric.maximumTransitions)
    throw new Error(
      'Only one automatic medium-to-high transition is allowed per leaf',
    );
  return { ...decision };
}
