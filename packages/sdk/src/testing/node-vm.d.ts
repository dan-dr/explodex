declare module "node:vm" {
  export function createContext(
    contextObject?: object,
    options?: {
      codeGeneration?: {
        strings?: boolean;
        wasm?: boolean;
      };
      microtaskMode?: "afterEvaluate";
    },
  ): object;

  export function runInContext(
    code: string,
    contextifiedObject: object,
    options?: {
      timeout?: number;
      displayErrors?: boolean;
    },
  ): unknown;
}
