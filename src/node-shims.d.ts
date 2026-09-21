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
declare module 'node:http' { const value: any; export default value; export type IncomingMessage = any; export type ServerResponse = any; export type Server = any; }
declare module 'node:url' { export const fileURLToPath: any; export const pathToFileURL: any; }
declare module 'node:assert/strict' { const value: { ok(value: unknown, message?: string): asserts value; [key: string]: any }; export default value; }
declare module 'node:test' { const value: any; export default value; }
declare module 'node:readline' { const value: any; export default value; }
