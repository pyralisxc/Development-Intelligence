import { promises as fs } from 'node:fs';

async function replaceOnce(path, before, after) {
  const source = await fs.readFile(path, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing expected anchor in ${path}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Expected exactly one anchor in ${path}`);
  await fs.writeFile(path, source.slice(0, first) + after + source.slice(first + before.length));
}

await replaceOnce(
  'src/intelligence/repository.ts',
  `    }\n    moduleInfos.set(relative, { sourceFile, imports, reexports, exportAll, importedSpecifiers });`,
  `    }\n\n    const visitDynamicImports = (node: ts.Node): void => {\n      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {\n        const module = node.arguments[0]!.text;\n        importedSpecifiers.push(module);\n        const targetFile = resolveTargetFile(relative, module);\n        const targetFileNode = targetFile ? fileNodes.get(targetFile) : null;\n        if (fromFile && targetFileNode) addedEdges.push(resolution({\n          from: fromFile.id,\n          to: targetFileNode.id,\n          kind: 'imports',\n          strategy: 'dynamic-module-resolution',\n          confidence: 1,\n          status: 'resolved',\n          evidence: [relative + ':' + lineOf(node)],\n          layer: 'structural',\n          checkpoint: false,\n        }));\n      }\n      ts.forEachChild(node, visitDynamicImports);\n    };\n    visitDynamicImports(sourceFile);\n    moduleInfos.set(relative, { sourceFile, imports, reexports, exportAll, importedSpecifiers });`,
);

await replaceOnce(
  'src/intelligence/repository.ts',
  `    const feature = featureByFile.get(relative);\n    if (feature) input.edges.push(semanticRelationship({ from: mcpId, to: \`feature:\${feature}\`, kind: 'implemented-by', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));\n  }`,
  `    const feature = featureByFile.get(relative);\n    if (feature) input.edges.push(semanticRelationship({ from: mcpId, to: \`feature:\${feature}\`, kind: 'implemented-by', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));\n    const route = routeByFile.get(relative);\n    if (route) input.edges.push(semanticRelationship({ from: route.id, to: mcpId, kind: 'exposes', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));\n  }`,
);

await replaceOnce(
  'scripts/benchmark-cardforge.mjs',
  `for (const [kind, minimum] of Object.entries({ feature: 0.8, api: 0.8, provider: 0.7 })) {\n  const result = parityByKind[kind];\n  if (result && result.recall < minimum) throw new Error(\`DI semantic migration benchmark \${kind} recall \${result.recall.toFixed(3)} is below \${minimum}\`);\n}\n`,
  `for (const kind of ['feature', 'api', 'provider', 'route', 'mcp']) {\n  const result = parityByKind[kind];\n  if (result && result.recall !== 1) throw new Error(\`DI generic semantic migration benchmark requires complete \${kind} identity recall; got \${result.recall.toFixed(3)}\`);\n}\n\nconst genericSemanticKinds = new Set(['feature', 'api', 'provider', 'route', 'mcp']);\nconst genericMissingEdges = missingEdges.filter((key) => {\n  const [from, _relation, to] = key.split('|');\n  const fromKind = from?.split(':', 1)[0];\n  const toKind = to?.split(':', 1)[0];\n  return Boolean(fromKind && toKind && genericSemanticKinds.has(fromKind) && genericSemanticKinds.has(toKind));\n});\nif (genericMissingEdges.length) {\n  throw new Error(\`DI generic semantic migration still misses \${genericMissingEdges.length} CardForge relationships: \${genericMissingEdges.slice(0, 12).join(', ')}\`);\n}\n`,
);

await replaceOnce(
  'scripts/benchmark-cardforge.mjs',
  `    byKind: parityByKind,\n    missingEdges: missingEdges.slice(0, 200),`,
  `    byKind: parityByKind,\n    genericMissingEdges,\n    missingEdges: missingEdges.slice(0, 200),`,
);

await replaceOnce(
  'scripts/benchmark-cardforge.mjs',
  `  \`Current generic DI exact semantic identity match: **\${exactNodeMatches}/\${oracle.nodes.length} nodes (\${(report.semanticDifferential.exactNodeRecall * 100).toFixed(1)}%)** and **\${matchedEdges.length}/\${oracle.edges.length} relationships (\${(report.semanticDifferential.exactEdgeRecall * 100).toFixed(1)}%)**.\`,\n  '',`,
  `  \`Current generic DI exact semantic identity match: **\${exactNodeMatches}/\${oracle.nodes.length} nodes (\${(report.semanticDifferential.exactNodeRecall * 100).toFixed(1)}%)** and **\${matchedEdges.length}/\${oracle.edges.length} relationships (\${(report.semanticDifferential.exactEdgeRecall * 100).toFixed(1)}%)**.\`,\n  \`- Generic-kind relationship gaps: **\${genericMissingEdges.length}**\`,\n  '',`,
);

console.log('semantic-gap-codemod: applied');
