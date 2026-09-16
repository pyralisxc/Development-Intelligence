/**
 * Source-adjacent semantic declarations for Development Intelligence itself.
 * These describe current product reality; they are not roadmap or expectation data.
 */
export const DEVELOPMENT_INTELLIGENCE_SEMANTICS = [
  {
    developmentIntelligence: {
      kind: 'feature',
      id: 'viewer',
      label: 'Graph viewer',
      relationships: [],
    },
  },
  {
    developmentIntelligence: {
      kind: 'surface',
      id: 'agent',
      label: 'Agent tools',
      role: 'agent',
      relationships: [
        { kind: 'exposes', to: 'capability:code-intelligence' },
        { kind: 'exposes', to: 'capability:parity-intelligence' },
        { kind: 'exposes', to: 'capability:architecture-intelligence' },
        { kind: 'exposes', to: 'capability:change-intelligence' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'surface',
      id: 'viewer',
      label: 'Human graph viewer',
      role: 'human',
      relationships: [
        { kind: 'exposes', to: 'capability:visual-intelligence' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'code-intelligence',
      label: 'Code intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:search_graph' },
        { kind: 'automated-by', to: 'mcp:trace_path' },
        { kind: 'automated-by', to: 'mcp:search_code' },
        { kind: 'automated-by', to: 'mcp:get_code_snippet' },
        { kind: 'automated-by', to: 'mcp:get_evidence' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'parity-intelligence',
      label: 'Parity intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:query_parity' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'architecture-intelligence',
      label: 'Architecture intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:get_architecture' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'change-intelligence',
      label: 'Change intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:diff_graph' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'visual-intelligence',
      label: 'Visual intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'implemented-by', to: 'feature:viewer' },
      ],
    },
  },
  ...[
    'list_projects',
    'project_status',
    'scan_graph',
    'search_graph',
    'trace_path',
    'search_code',
    'get_code_snippet',
    'get_graph_schema',
    'get_architecture',
    'check_graph_coverage',
    'get_evidence',
    'diff_graph',
    'query_parity',
  ].map(id => ({
    developmentIntelligence: {
      kind: 'mcp',
      id,
      label: id,
      relationships: [],
    },
  })),
] as const;
