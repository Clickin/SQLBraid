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
    oracle: {
      readonly connectionUri: string;
      readonly image: string;
      readonly version: string;
    };
    mssql: {
      readonly server: string;
      readonly port: number;
      readonly userName: string;
      readonly password: string;
      readonly database: string;
      readonly connectionUri: string;
      readonly image: string;
      readonly version: string;
    };
  }
}

export {};
