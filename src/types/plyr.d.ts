// Plyr's bundled .d.ts mixes `export =` with `export default`, which breaks
// strict ESM imports under verbatimModuleSyntax. This shim re-exports only
// the default so `import Plyr from "plyr"` resolves cleanly.
declare module "plyr" {
  class Plyr {
    constructor(
      targets: NodeList | HTMLElement | HTMLElement[] | string,
      options?: Record<string, unknown>,
    );
    destroy(callback?: () => void, soft?: boolean): void;
    on(event: string, callback: (event: Event) => void): void;
    off(event: string, callback: (event: Event) => void): void;
  }
  export default Plyr;
}
