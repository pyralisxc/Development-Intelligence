import { indexRevisionNow } from './codebase/sourceManager.js';

const project = process.env.DEVINT_INDEX_PROJECT;
const ref = process.env.DEVINT_INDEX_REF;
const sha = process.env.DEVINT_INDEX_SHA;

if (!project) throw new Error('DEVINT_INDEX_PROJECT is required for the indexing job');
if (!sha) throw new Error('DEVINT_INDEX_SHA is required for the indexing job');

try {
  const result = await indexRevisionNow(project, ref || undefined, sha);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
