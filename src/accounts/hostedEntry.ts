import { promises as fs } from 'node:fs';
import { executeAccountGraphJob } from './localComputer.js';
import type { BuildJob } from './workspace.js';

/** A hosted process executes the same graph job as a linked computer. */
async function main(): Promise<void> {
  const [inputFile, statusFile, dataDir, scratchDir] = process.argv.slice(2);
  if (!inputFile || !statusFile || !dataDir || !scratchDir) throw new Error('Hosted graph job arguments are incomplete');
  const input = JSON.parse(await fs.readFile(inputFile, 'utf8')) as { job: BuildJob; callback: { origin: string; userId: string } };
  const { job, callback } = input;
  const token = process.env.DEVINT_HOSTED_GITHUB_TOKEN || null;
  delete process.env.DEVINT_HOSTED_GITHUB_TOKEN;
  // The mounted Drive is the store visible to this execution service.
  const graph = { ...job.graph, buildComputer: 'hosted', storage: { computer: 'hosted', location: dataDir }, query: { computer: 'hosted', location: dataDir } };
  let writes = Promise.resolve();
  const publish = (value: unknown) => {
    writes = writes.then(async () => {
      const temporary = `${statusFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, statusFile);
    });
    return writes;
  };
  try {
    await publish({ state: 'running', progress: { stage: 'starting' } });
    const result = await executeAccountGraphJob({ ...job, graph }, scratchDir, 3, async () => token,
      async progress => await publish({ state: 'running', progress }));
    await publish({ state: 'complete', result });
  } catch (error) {
    await publish({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    // The scoped claim lets the account service record the result and stop the
    // Sandbox even if the user has closed the Workbench.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(new URL('/account/hosted-finish', callback.origin), { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: callback.userId, jobId: job.id, claimId: job.claimId }) });
        if (response.ok) break;
      } catch { /* A later Workbench poll can also finish the job. */ }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
