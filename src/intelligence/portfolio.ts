import type { IntelligenceGraph, RelationshipStatus } from '../types.js';

export interface PortfolioParticipantInput {
  key?: string;
  project: string;
  ref?: string;
  graphId?: string;
}

interface Participant {
  key: string;
  project: string;
  graph: IntelligenceGraph;
}

interface Unavailable {
  key: string;
  project: string;
  error: string;
}

export function synthesizePortfolio(
  participants: Participant[],
  unavailable: Unavailable[] = [],
  _limit = 50,
): Record<string, unknown> {
  return {
    participants: participants.map(item => ({
      key: item.key,
      project: item.project,
      graphId: item.graph.graphId,
      revision: item.graph.repositoryRevision,
    })),
    unavailableParticipants: unavailable,
    policy: {
      persisted: false,
      participantAuthorityPreserved: true,
    },
  };
}

export function tracePortfolioGraphs(
  participants: Participant[],
  unavailable: Unavailable[],
  input: {
    start: string;
    direction?: 'inbound' | 'outbound' | 'both';
    depth?: number;
    statuses?: RelationshipStatus[];
    limit?: number;
  },
): Record<string, unknown> {
  return {
    ...synthesizePortfolio(participants, unavailable),
    start: input.start,
    nodes: [],
    hops: [],
    crossRepositoryHopCount: 0,
  };
}

export async function inspectPortfolio(_input: {
  participants: PortfolioParticipantInput[];
  limit?: number;
}): Promise<Record<string, unknown>> {
  throw new Error('portfolio participant resolution is not enabled in this diagnostic candidate');
}

export async function tracePortfolio(_input: {
  participants: PortfolioParticipantInput[];
  start: string;
  direction?: 'inbound' | 'outbound' | 'both';
  depth?: number;
  statuses?: RelationshipStatus[];
  limit?: number;
}): Promise<Record<string, unknown>> {
  throw new Error('portfolio participant resolution is not enabled in this diagnostic candidate');
}
