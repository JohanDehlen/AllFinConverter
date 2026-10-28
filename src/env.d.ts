/// <reference path="../.astro/types.d.ts" />

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function unlinkSync(path: string): void;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
    COINMARKETCAP_API_KEY?: string;
  }
  interface Process {
    env: ProcessEnv;
    cwd(): string;
    exit(code?: number): never;
    exitCode?: number;
  }
}

declare const process: NodeJS.Process;

declare const Buffer: {
  byteLength(string: string, encoding?: string): number;
};
