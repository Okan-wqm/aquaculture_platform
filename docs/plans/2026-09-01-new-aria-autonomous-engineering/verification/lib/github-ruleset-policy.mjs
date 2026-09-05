function malformed(message) {
  throw new Error(`GitHub ruleset ${message} is malformed`);
}

function validRuleType(value) {
  return typeof value === 'string' && value.length > 0;
}

export function effectiveRulesetIds(rules, repositorySlug) {
  if (!Array.isArray(rules)) malformed('effective list');
  const identifiers = rules.map((rule) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      !validRuleType(rule.type) ||
      rule.ruleset_source_type !== 'Repository' ||
      rule.ruleset_source !== repositorySlug ||
      !Number.isSafeInteger(rule.ruleset_id) ||
      rule.ruleset_id < 1
    ) {
      malformed('effective rule');
    }
    return rule.ruleset_id;
  });
  return [...new Set(identifiers)].sort((left, right) => left - right);
}

function validateConditions(ruleset, baseRef) {
  const refName = ruleset?.conditions?.ref_name;
  if (
    !refName ||
    !Array.isArray(refName.include) ||
    !Array.isArray(refName.exclude) ||
    [...refName.include, ...refName.exclude].some((value) => typeof value !== 'string')
  ) {
    malformed('ref condition');
  }
  const target = `refs/heads/${baseRef}`;
  const selectors = [target, '~DEFAULT_BRANCH'];
  const included = refName.include.some((value) => selectors.includes(value));
  const excluded = refName.exclude.some((value) => selectors.includes(value));
  if (!included || excluded) throw new Error('GitHub ruleset is not applicable to exact main');
}

function validIdentity(ruleset, identifier, repositorySlug) {
  return (
    ruleset &&
    typeof ruleset === 'object' &&
    ruleset.id === identifier &&
    ruleset.source_type === 'Repository' &&
    ruleset.source === repositorySlug
  );
}

function validRules(rules) {
  return (
    Array.isArray(rules) && rules.length > 0 && rules.every((rule) => validRuleType(rule?.type))
  );
}

function validateRuleset(ruleset, identifier, repositorySlug, baseRef) {
  if (!validIdentity(ruleset, identifier, repositorySlug)) malformed('detail');
  if (!Array.isArray(ruleset.bypass_actors) || !validRules(ruleset.rules)) malformed('detail');
  if (ruleset.target !== 'branch') throw new Error('GitHub ruleset target must be branch');
  if (ruleset.enforcement !== 'active') throw new Error('GitHub ruleset must be active');
  if (ruleset.bypass_actors.length > 0) throw new Error('GitHub ruleset bypass actor is enabled');
  if (ruleset.current_user_can_bypass !== 'never')
    throw new Error('GitHub ruleset bypass is enabled');
  validateConditions(ruleset, baseRef);
}

export function validatedRulesets(details, identifiers, repositorySlug, baseRef) {
  if (!Array.isArray(details) || details.length !== identifiers.length) {
    malformed('detail set');
  }
  const byId = new Map(details.map((ruleset) => [ruleset?.id, ruleset]));
  if (byId.size !== identifiers.length) malformed('detail identity');
  for (const identifier of identifiers) {
    validateRuleset(byId.get(identifier), identifier, repositorySlug, baseRef);
  }
  return identifiers.map((identifier) => byId.get(identifier));
}
