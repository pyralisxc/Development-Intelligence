import { Transform } from 'node:stream';

/** Node's native TestStream events, not the unstable text of spec/TAP output. */
export default new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(event.type)) {
      callback();
      return;
    }
    const data = event.data || {};
    const filtered = event.type === 'test:summary'
      ? { success: data.success === true, counts: data.counts }
      : { name: data.name, file: data.file, line: data.line, column: data.column,
          nesting: data.nesting, testNumber: data.testNumber };
    callback(null, JSON.stringify({ schemaVersion: 1, type: event.type, data: filtered }) + '\n');
  },
});
