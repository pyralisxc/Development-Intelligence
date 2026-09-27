function unique(values) {
  return [...new Set(values)];
}

function ratio(numerator, denominator, emptyValue = 1) {
  if (denominator === 0) return emptyValue;
  return Number((numerator / denominator).toFixed(6));
}

export function relationshipKey(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') throw new Error('relationship must be a string key or object');
  const { from, kind, to } = value;
  if (![from, kind, to].every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error('relationship objects require non-empty from, kind, and to');
  }
  return `${from}|${kind}|${to}`;
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.length)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return unique(value);
}

function relationshipList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return unique(value.map(relationshipKey));
}

function truthSet(value, field, relationship = false) {
  if (value === undefined) return { required: [], forbidden: [], complete: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return {
    required: relationship ? relationshipList(value.required, `${field}.required`) : stringList(value.required, `${field}.required`),
    forbidden: relationship ? relationshipList(value.forbidden, `${field}.forbidden`) : stringList(value.forbidden, `${field}.forbidden`),
    complete: value.complete === true,
  };
}

function optionalString(value, field) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalBoolean(value, field) {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`);
  return value;
}

function semanticExpectation(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  if (typeof value.scope !== 'string' || !value.scope.trim()) throw new Error(`${field}.scope must be non-empty`);
  const minEvidenceFamilies = value.minEvidenceFamilies === undefined ? null : Number(value.minEvidenceFamilies);
  if (minEvidenceFamilies !== null && (!Number.isInteger(minEvidenceFamilies) || minEvidenceFamilies < 0)) {
    throw new Error(`${field}.minEvidenceFamilies must be a non-negative integer`);
  }
  return {
    scope: value.scope.trim(),
    name: optionalString(value.name, `${field}.name`),
    kind: optionalString(value.kind, `${field}.kind`),
    evidenceFamilies: stringList(value.evidenceFamilies, `${field}.evidenceFamilies`),
    minEvidenceFamilies,
    origin: optionalString(value.origin, `${field}.origin`),
    accepted: optionalBoolean(value.accepted, `${field}.accepted`),
    reviewed: optionalBoolean(value.reviewed, `${field}.reviewed`),
    persisted: optionalBoolean(value.persisted, `${field}.persisted`),
    proofEligible: optionalBoolean(value.proofEligible, `${field}.proofEligible`),
    requiresExplicitReview: optionalBoolean(value.requiresExplicitReview, `${field}.requiresExplicitReview`),
  };
}

function semanticTruthSet(value, field) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const requiredInput = value.required ?? [];
  const forbiddenInput = value.forbidden ?? [];
  if (!Array.isArray(requiredInput) || !Array.isArray(forbiddenInput)) {
    throw new Error(`${field}.required and ${field}.forbidden must be arrays`);
  }
  const universeScopes = stringList(value.universeScopes, `${field}.universeScopes`);
  const required = requiredInput.map((item, index) => semanticExpectation(item, `${field}.required[${index}]`));
  const forbidden = forbiddenInput.map((item, index) => semanticExpectation(item, `${field}.forbidden[${index}]`));
  if (universeScopes.length) {
    const universe = new Set(universeScopes);
    for (const item of [...required, ...forbidden]) {
      if (!universe.has(item.scope)) throw new Error(`${field} expectation scope ${item.scope} is outside universeScopes`);
    }
  }
  return { required, forbidden, universeScopes, complete: value.complete === true };
}

function semanticObservation(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  if (typeof value.scope !== 'string' || !value.scope.trim()) throw new Error(`${field}.scope must be non-empty`);
  const proposal = value.proposal && typeof value.proposal === 'object' ? value.proposal : {};
  const provenance = value.provenance && typeof value.provenance === 'object' ? value.provenance : {};
  const authority = value.authority && typeof value.authority === 'object' ? value.authority : {};
  const evidenceFamilies = value.evidenceFamilies ?? provenance.evidenceFamilies;
  return {
    scope: value.scope.trim(),
    name: typeof (value.name ?? proposal.name) === 'string' ? String(value.name ?? proposal.name) : null,
    kind: typeof (value.kind ?? proposal.kind) === 'string' ? String(value.kind ?? proposal.kind) : null,
    evidenceFamilies: stringList(evidenceFamilies, `${field}.evidenceFamilies`),
    origin: typeof (value.origin ?? provenance.origin) === 'string' ? String(value.origin ?? provenance.origin) : null,
    accepted: typeof (value.accepted ?? authority.accepted) === 'boolean' ? Boolean(value.accepted ?? authority.accepted) : null,
    reviewed: typeof (value.reviewed ?? authority.reviewed) === 'boolean' ? Boolean(value.reviewed ?? authority.reviewed) : null,
    persisted: typeof (value.persisted ?? authority.persisted) === 'boolean' ? Boolean(value.persisted ?? authority.persisted) : null,
    proofEligible: typeof (value.proofEligible ?? authority.proofEligible) === 'boolean' ? Boolean(value.proofEligible ?? authority.proofEligible) : null,
    requiresExplicitReview: typeof (value.requiresExplicitReview ?? authority.requiresExplicitReview) === 'boolean'
      ? Boolean(value.requiresExplicitReview ?? authority.requiresExplicitReview)
      : null,
  };
}

function semanticObservationList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => semanticObservation(item, `${field}[${index}]`));
}

function semanticExpectationKey(value) {
  return [value.scope, value.kind ?? '*', value.name ?? '*'].join('|');
}

function semanticObservationKey(value) {
  return [value.scope, value.kind ?? '?', value.name ?? '?'].join('|');
}

function semanticMatches(expected, observed) {
  if (expected.scope !== observed.scope) return false;
  if (expected.name !== null && expected.name !== observed.name) return false;
  if (expected.kind !== null && expected.kind !== observed.kind) return false;
  if (expected.origin !== null && expected.origin !== observed.origin) return false;
  for (const field of ['accepted', 'reviewed', 'persisted', 'proofEligible', 'requiresExplicitReview']) {
    if (expected[field] !== null && expected[field] !== observed[field]) return false;
  }
  if (expected.minEvidenceFamilies !== null && observed.evidenceFamilies.length < expected.minEvidenceFamilies) return false;
  const observedFamilies = new Set(observed.evidenceFamilies);
  if (expected.evidenceFamilies.some(family => !observedFamilies.has(family))) return false;
  return true;
}

export function normalizeAccuracyCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('case must be an object');
  if (value.version !== 1) throw new Error('case.version must be 1');
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('case.id must be non-empty');
  if (typeof value.capability !== 'string' || !value.capability.trim()) throw new Error('case.capability must be non-empty');
  if (typeof value.project !== 'string' || !value.project.trim()) throw new Error('case.project must be non-empty');
  if (typeof value.ref !== 'string' || !value.ref.trim()) throw new Error('case.ref must be non-empty');
  const groundTruth = value.groundTruth ?? {};
  const answerStatuses = stringList(groundTruth.answerStatuses, 'case.groundTruth.answerStatuses');
  return {
    version: 1,
    id: value.id.trim(),
    capability: value.capability.trim(),
    language: typeof value.language === 'string' && value.language.trim() ? value.language.trim() : 'unknown',
    project: value.project.trim(),
    ref: value.ref.trim(),
    question: typeof value.question === 'string' ? value.question : null,
    groundTruth: {
      entities: truthSet(groundTruth.entities, 'case.groundTruth.entities'),
      relationships: truthSet(groundTruth.relationships, 'case.groundTruth.relationships', true),
      semanticCandidates: semanticTruthSet(groundTruth.semanticCandidates, 'case.groundTruth.semanticCandidates'),
      answerStatuses,
    },
    provenance: Array.isArray(value.provenance) ? value.provenance : [],
  };
}

export function normalizeAccuracyObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('observation must be an object');
  if (typeof value.caseId !== 'string' || !value.caseId.trim()) throw new Error('observation.caseId must be non-empty');
  return {
    caseId: value.caseId.trim(),
    entities: stringList(value.entities, 'observation.entities'),
    relationships: relationshipList(value.relationships, 'observation.relationships'),
    semanticCandidates: semanticObservationList(value.semanticCandidates, 'observation.semanticCandidates'),
    answerStatus: typeof value.answerStatus === 'string' ? value.answerStatus : null,
  };
}

function scoreSet(expected, observed) {
  const required = new Set(expected.required);
  const forbidden = new Set(expected.forbidden);
  const actual = new Set(observed);
  const requiredFound = [...required].filter(item => actual.has(item));
  const missingRequired = [...required].filter(item => !actual.has(item));
  const forbiddenPresent = [...forbidden].filter(item => actual.has(item));
  const relevantObserved = [...actual].filter(item => required.has(item));
  const falseObserved = expected.complete ? [...actual].filter(item => !required.has(item)) : [];
  return {
    required: required.size,
    observed: actual.size,
    requiredFound: requiredFound.length,
    missingRequired,
    forbiddenPresent,
    completeGroundTruth: expected.complete,
    recall: ratio(requiredFound.length, required.size),
    precision: expected.complete ? ratio(relevantObserved.length, actual.size) : null,
    falseObserved,
  };
}

function scoreSemanticCandidates(expected, observations) {
  if (expected === null) return null;
  const universe = new Set(expected.universeScopes);
  const actual = universe.size ? observations.filter(item => universe.has(item.scope)) : observations;
  const requiredFound = expected.required.filter(item => actual.some(observed => semanticMatches(item, observed)));
  const missingRequired = expected.required.filter(item => !actual.some(observed => semanticMatches(item, observed)));
  const forbiddenPresent = expected.forbidden.filter(item => actual.some(observed => semanticMatches(item, observed)));
  const relevantObserved = actual.filter(observed => expected.required.some(item => semanticMatches(item, observed)));
  const falseObserved = expected.complete
    ? actual.filter(observed => !expected.required.some(item => semanticMatches(item, observed)))
    : [];
  return {
    required: expected.required.length,
    observed: actual.length,
    requiredFound: requiredFound.length,
    missingRequired: missingRequired.map(semanticExpectationKey),
    forbiddenPresent: forbiddenPresent.map(semanticExpectationKey),
    universeScopes: expected.universeScopes,
    completeGroundTruth: expected.complete,
    recall: ratio(requiredFound.length, expected.required.length),
    precision: expected.complete ? ratio(relevantObserved.length, actual.length) : null,
    falsePositiveRate: expected.complete ? ratio(falseObserved.length, actual.length, 0) : null,
    falseObserved: falseObserved.map(semanticObservationKey),
  };
}

export function scoreAccuracyCase(caseInput, observationInput) {
  const challenge = normalizeAccuracyCase(caseInput);
  const observation = normalizeAccuracyObservation(observationInput);
  if (observation.caseId !== challenge.id) throw new Error(`observation ${observation.caseId} does not match case ${challenge.id}`);

  const entityScore = scoreSet(challenge.groundTruth.entities, observation.entities);
  const relationshipScore = scoreSet(challenge.groundTruth.relationships, observation.relationships);
  const semanticCandidateScore = scoreSemanticCandidates(challenge.groundTruth.semanticCandidates, observation.semanticCandidates);
  const allowedStatuses = challenge.groundTruth.answerStatuses;
  const answerStatusPass = allowedStatuses.length === 0 || (observation.answerStatus !== null && allowedStatuses.includes(observation.answerStatus));
  const semanticPass = semanticCandidateScore === null
    || (semanticCandidateScore.missingRequired.length === 0
      && semanticCandidateScore.forbiddenPresent.length === 0
      && semanticCandidateScore.falseObserved.length === 0);
  const pass = entityScore.missingRequired.length === 0
    && entityScore.forbiddenPresent.length === 0
    && relationshipScore.missingRequired.length === 0
    && relationshipScore.forbiddenPresent.length === 0
    && entityScore.falseObserved.length === 0
    && relationshipScore.falseObserved.length === 0
    && semanticPass
    && answerStatusPass;

  return {
    caseId: challenge.id,
    capability: challenge.capability,
    language: challenge.language,
    pass,
    entityScore,
    relationshipScore,
    semanticCandidateScore,
    answerStatus: {
      observed: observation.answerStatus,
      allowed: allowedStatuses,
      pass: answerStatusPass,
    },
  };
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(6));
}

export function scoreAccuracySuite(cases, observations) {
  if (!Array.isArray(cases) || !Array.isArray(observations)) throw new Error('cases and observations must be arrays');
  const byId = new Map(observations.map(item => [item.caseId, item]));
  const results = cases.map(item => {
    const observation = byId.get(item.id);
    if (!observation) throw new Error(`missing observation for case ${item.id}`);
    return scoreAccuracyCase(item, observation);
  });
  const completeEntityPrecision = results.map(item => item.entityScore.precision).filter(value => value !== null);
  const completeRelationshipPrecision = results.map(item => item.relationshipScore.precision).filter(value => value !== null);
  const semanticScores = results.map(item => item.semanticCandidateScore).filter(value => value !== null);
  const completeSemanticPrecision = semanticScores.map(item => item.precision).filter(value => value !== null);
  const completeSemanticFalsePositiveRates = semanticScores.map(item => item.falsePositiveRate).filter(value => value !== null);
  return {
    cases: results.length,
    passed: results.filter(item => item.pass).length,
    failed: results.filter(item => !item.pass).length,
    entityRecall: average(results.map(item => item.entityScore.recall)),
    entityPrecision: average(completeEntityPrecision),
    relationshipRecall: average(results.map(item => item.relationshipScore.recall)),
    relationshipPrecision: average(completeRelationshipPrecision),
    semanticCandidateRecall: average(semanticScores.map(item => item.recall)),
    semanticCandidatePrecision: average(completeSemanticPrecision),
    semanticCandidateFalsePositiveRate: average(completeSemanticFalsePositiveRates),
    results,
  };
}
