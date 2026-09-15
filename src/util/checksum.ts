import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const stat = await fs.stat(file);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk: any) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return { sha256: hash.digest('hex'), bytes: stat.size };
}
