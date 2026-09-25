import { promises as fs } from 'node:fs';
import { scoreAccuracySuite } from './accuracy-benchmark-lib.mjs';

const casesPath = process.argv[2];
const observationsPath = process.argv[3];
if (!casesPath || !observationsPath) {
  throw new Error('usage: node scripts/benchmark-accuracy.mjs <cases.json> <observations.json>');
}

const casesDocument = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const observationsDocument = JSON.parse(await fs.readFile(observationsPath, 'utf8'));
if (casesDocument.version !== 1 || !Array.isArray(casesDocument.cases)) throw new Error('cases document must be { version: 1, cases: [...] }');
if (observationsDocument.version !== 1 || !Array.isArray(observationsDocument.observations)) throw new Error('observations document must be { version: 1, observations: [...] }');

const scorecard = scoreAccuracySuite(casesDocument.cases, observationsDocument.observations);
console.log(JSON.stringify(scorecard, null, 2));
if (scorecard.failed > 0) process.exitCode = 1;
