// Minimal shims for optional libraries that documentation examples import but
// that the tests package does not install with type declarations.
declare module "decimal.js" {
  const Decimal: new (value: string | number) => object;
  export default Decimal;
}

declare module "better-sqlite3" {
  // The real driver object is checked by the adapter suites, not here.
  const Database: new (filename: string, options?: object) => any;
  export default Database;
}
