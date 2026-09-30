declare type Buffer = any;
declare const Buffer: any;
declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined } interface ErrnoException extends Error { code?: string } }
declare const process: { env: NodeJS.ProcessEnv; [key: string]: any };
declare module 'node:crypto' {
  export const createHash: any;
  export const createHmac: any;
  export const createPrivateKey: any;
  export const generateKeyPairSync: any;
  export const randomBytes: any;
  export const sign: any;
  export const timingSafeEqual: any;
}
declare module 'node:fs' { export const promises: any; }
declare module 'node:path' { const value: any; export default value; }
declare module 'node:os' { const value: any; export default value; }
declare module 'node:child_process' { export const spawn: any; }
declare module 'node:worker_threads' {
  export const isMainThread: boolean;
  export const parentPort: { postMessage(value: unknown): void } | null;
  export const workerData: unknown;
  export class Worker {
    constructor(filename: URL, options?: { workerData?: unknown; resourceLimits?: { maxOldGenerationSizeMb?: number } });
    once(event: 'message', listener: (value: any) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number) => void): this;
    terminate(): Promise<number>;
  }
}
declare module 'node:http' { const value: any; export default value; export type IncomingMessage = any; export type ServerResponse = any; export type Server = any; }
declare module 'node:url' { export const fileURLToPath: any; export const pathToFileURL: any; }
declare module 'node:assert/strict' { const value: { ok(value: unknown, message?: string): asserts value; [key: string]: any }; export default value; }
declare module 'node:test' { const value: any; export default value; }
declare module 'node:readline' { const value: any; export default value; }
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
    getStore(): T | undefined;
  }
}

declare module 'node:zlib' {
  export const gzipSync: any;
  export const gunzipSync: any;
}
