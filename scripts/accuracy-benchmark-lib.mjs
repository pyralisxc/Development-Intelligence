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
      motifs: truthSet(groundTruth.motifs, 'case.groundTruth.motifs'),
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
    motifs: stringList(value.motifs, 'observation.motifs'),
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

export function scoreAccuracyCase(caseInput, observationInput) {
  const challenge = normalizeAccuracyCase(caseInput);
  const observation = normalizeAccuracyObservation(observationInput);
  if (observation.caseId !== challenge.id) throw new Error(`observation ${observation.caseId} does not match case ${challenge.id}`);

  const entityScore = scoreSet(challenge.groundTruth.entities, observation.entities);
  const relationshipScore = scoreSet(challenge.groundTruth.relationships, observation.relationships);
  const motifScore = scoreSet(challenge.groundTruth.motifs, observation.motifs);
  const allowedStatuses = challenge.groundTruth.answerStatuses;
  const answerStatusPass = allowedStatuses.length === 0 || (observation.answerStatus !== null && allowedStatuses.includes(observation.answerStatus));
  const pass = entityScore.missingRequired.length === 0
    && entityScore.forbiddenPresent.length === 0
    && relationshipScore.missingRequired.length === 0
    && relationshipScore.forbiddenPresent.length === 0
    && entityScore.falseObserved.length === 0
    && relationshipScore.falseObserved.length === 0
    && motifScore.missingRequired.length === 0
    && motifScore.forbiddenPresent.length === 0
    && motifScore.falseObserved.length === 0
    && answerStatusPass;

  return {
    caseId: challenge.id,
    capability: challenge.capability,
    language: challenge.language,
    pass,
    entityScore,
    relationshipScore,
    motifScore,
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
  const completeMotifPrecision = results.map(item => item.motifScore.precision).filter(value => value !== null);
  return {
    cases: results.length,
    passed: results.filter(item => item.pass).length,
    failed: results.filter(item => !item.pass).length,
    entityRecall: average(results.map(item => item.entityScore.recall)),
    entityPrecision: average(completeEntityPrecision),
    relationshipRecall: average(results.map(item => item.relationshipScore.recall)),
    relationshipPrecision: average(completeRelationshipPrecision),
    motifRecall: average(results.map(item => item.motifScore.recall)),
    motifPrecision: average(completeMotifPrecision),
    results,
  };
}
