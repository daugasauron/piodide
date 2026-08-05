declare module "wasm-git/lg2.js" {
  interface WasmGitModule {
    FS: any;
    HEAPU8: Uint8Array;
    MEMFS: any;
    callMain(args: string[]): number;
  }

  interface WasmGitOptions {
    locateFile?: (path: string) => string;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }

  export default function init(options?: WasmGitOptions): Promise<WasmGitModule>;
}

declare module "wasm-git/lg2.wasm?url" {
  const url: string;
  export default url;
}
