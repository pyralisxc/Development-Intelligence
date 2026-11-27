import { createRequire } from 'node:module';
export interface ActionHint { word: string; relation: 'synonym' | 'hypernym'; sense: string | number; relatedSense?: string | number }
type Sense = { synsetOffset: string | number; synonyms: string[]; ptrs: Array<{ pointerSymbol: string; synsetOffset: string; pos: string }> };
type Dictionary = { lookupVerb(word: string): Promise<Sense[]>; seek(offset: number, pos: string): Promise<Sense | undefined> };
const require = createRequire(import.meta.url);
let dictionary: Dictionary | undefined;
const cache = new Map<string, Promise<ActionHint[]>>();
export function lexicalActionHints(word: string): Promise<ActionHint[]> {
  let result = cache.get(word);
  if (!result) {
    result = (async () => {
      const WordPOS = require('wordpos') as new () => Dictionary;
      const wordnet = dictionary ??= new WordPOS();
      const output: ActionHint[] = [];
      for (const sense of await wordnet.lookupVerb(word)) {
        for (const value of sense.synonyms) output.push({ word: value.replaceAll('_', ' ').toLowerCase(), relation: 'synonym', sense: sense.synsetOffset });
        for (const pointer of sense.ptrs.filter(ptr => ptr.pointerSymbol === '@' && ptr.pos === 'v')) {
          const parent = await wordnet.seek(Number(pointer.synsetOffset), pointer.pos);
          if (parent) for (const value of parent.synonyms) output.push({ word: value.replaceAll('_', ' ').toLowerCase(), relation: 'hypernym', sense: sense.synsetOffset, relatedSense: parent.synsetOffset });
        }
      }
      const unique = new Map<string, ActionHint>();
      for (const hint of output) if (hint.word && hint.word !== word && !unique.has(hint.word)) unique.set(hint.word, hint);
      return [...unique.values()];
    })();
    cache.set(word, result); result.catch(() => cache.delete(word));
  }
  return result;
}
