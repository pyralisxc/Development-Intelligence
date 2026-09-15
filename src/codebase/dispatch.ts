import { GoogleAuth } from 'google-auth-library';

export async function dispatchIndexJob(project: string, ref: string): Promise<{ operationName: string | null }> {
  const resource = process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE?.trim();
  if (!resource) throw new Error('DEVINT_CLOUD_RUN_JOB_RESOURCE is not configured');
  if (!/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(resource)) throw new Error('DEVINT_CLOUD_RUN_JOB_RESOURCE must be a full Cloud Run v2 job resource name');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Unable to obtain Google Cloud access token for index job dispatch');
  const response = await fetch(`https://run.googleapis.com/v2/${resource}:run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{
          env: [
            { name: 'DEVINT_INDEX_EXECUTION', value: '1' },
            { name: 'DEVINT_INDEX_PROJECT', value: project },
            { name: 'DEVINT_INDEX_REF', value: ref },
          ],
        }],
      },
    }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Cloud Run index job dispatch failed (${response.status}): ${JSON.stringify(body).slice(0, 1000)}`);
  return { operationName: typeof body.name === 'string' ? body.name : null };
}
