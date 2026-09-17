/**
 * Source-adjacent semantic declarations for Development Intelligence itself.
 * These describe current product reality; they are not roadmap or expectation data.
 */
export const DEVELOPMENT_INTELLIGENCE_SEMANTICS = [
  {
    developmentIntelligence: {
      kind: 'feature',
      id: 'workbench',
      label: 'Development Intelligence Workbench',
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
        { kind: 'exposes', to: 'capability:source-intelligence' },
        { kind: 'exposes', to: 'capability:inspection-intelligence' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'surface',
      id: 'workbench',
      label: 'Human intelligence workbench',
      role: 'human',
      relationships: [
        { kind: 'exposes', to: 'capability:visual-intelligence' },
        { kind: 'exposes', to: 'capability:source-intelligence' },
        { kind: 'exposes', to: 'capability:inspection-intelligence' },
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
      id: 'source-intelligence',
      label: 'Technical source intelligence',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:list_sources' },
        { kind: 'automated-by', to: 'mcp:query_source' },
      ],
    },
  },
  {
    developmentIntelligence: {
      kind: 'capability',
      id: 'inspection-intelligence',
      label: 'Inspection and synthesis',
      category: 'technical-intelligence',
      relationships: [
        { kind: 'automated-by', to: 'mcp:project_overview' },
        { kind: 'automated-by', to: 'mcp:inspect_entity' },
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
        { kind: 'implemented-by', to: 'feature:workbench' },
      ],
    },
  },
  ...[
    'list_projects',
    'project_status',
    'project_overview',
    'inspect_entity',
    'list_sources',
    'query_source',
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
