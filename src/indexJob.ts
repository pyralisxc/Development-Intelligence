import { indexRevisionNow } from './codebase/sourceManager.js';

const project = process.env.DEVINT_INDEX_PROJECT;
const ref = process.env.DEVINT_INDEX_REF;

if (!project) throw new Error('DEVINT_INDEX_PROJECT is required for the indexing job');

try {
  const result = await indexRevisionNow(project, ref || undefined);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
