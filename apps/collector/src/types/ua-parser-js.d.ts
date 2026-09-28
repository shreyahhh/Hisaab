// ua-parser-js 1.x ships no type declarations, and `@types/ua-parser-js` is not on the approved
// dependency list (SPEC §3 approves ua-parser-js itself, pinned to 1.x — 2.x is AGPL). This declares
// only the part the Collector calls.
declare module 'ua-parser-js' {
  interface UAResult {
    readonly browser: { readonly name?: string };
    readonly os: { readonly name?: string };
    readonly device: { readonly type?: string };
  }
  class UAParser {
    constructor(userAgent?: string);
    getResult(): UAResult;
  }
  export = UAParser;
}
