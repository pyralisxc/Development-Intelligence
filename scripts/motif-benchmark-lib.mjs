import { scoreAccuracySuite } from './accuracy-benchmark-lib.mjs';

export function motifObservation(challenge, graph, assessGraph) {
  const subject = challenge.subject;
  if (typeof subject !== 'string' || !subject.length) throw new Error('motif case ' + challenge.id + ' requires subject');
  const exact = graph.nodes.find(node => node.id === subject);
  const named = exact ? [] : graph.nodes.filter(node => node.name === subject);
  const selected = exact ?? (named.length === 1 ? named[0] : null);
  if (!selected) throw new Error('motif case ' + challenge.id + ' subject did not resolve uniquely: ' + subject);
  const assessment = assessGraph(graph, selected.id);
  return {
    caseId: challenge.id,
    entities: [],
    relationships: [],
    motifs: (assessment.orientation?.certainty?.derived ?? []).map(item => item.kind),
    answerStatus: assessment.answerStatus ?? null,
  };
}

export function scoreMotifCases(cases, graph, assessGraph) {
  const observations = cases.map(challenge => motifObservation(challenge, graph, assessGraph));
  return scoreAccuracySuite(cases, observations);
}
