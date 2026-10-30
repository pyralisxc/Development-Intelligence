import { GRAPH_SCHEMA_VERSION } from './types.js';
import { ANALYZER_VERSION } from './intelligence/repository.js';
import { SOURCE_ANALYSIS_SUPPORT } from './intelligence/analyzers/index.js';
import { QUERY_ARTIFACT_FORMAT_VERSION, CURRENT_QUERY_POINTER_PATH } from './intelligence/queryArtifactStore.js';

/** Exact-source software facts; neither host observation nor graph authority. */
export function engineDescriptor() {
  return {
    graphSchemaVersions: [GRAPH_SCHEMA_VERSION],
    analyzerVersion: ANALYZER_VERSION,
    queryArtifactVersions: [QUERY_ARTIFACT_FORMAT_VERSION],
    queryPointerPath: CURRENT_QUERY_POINTER_PATH,
    sourceAnalysis: SOURCE_ANALYSIS_SUPPORT.map(item => ({ technology: item.technology, precision: item.precision })),
  };
}
