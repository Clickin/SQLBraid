declare module "vitest" {
  interface ProvidedContext {
    postgres: {
      readonly connectionUri: string;
      readonly image: string;
      readonly version: string;
    };
    mysql: {
      readonly connectionUri: string;
      readonly image: string;
      readonly version: string;
    };
  }
}

export {};
