// Ambient globals available inside the headless Foundry page.
// The page-side domain library (src/page/**) runs in the browser with these in scope.
// foundry-vtt-types (v9) doesn't cover Foundry 14, so we declare the surface we use loosely;
// correctness is guaranteed by the live oracle/acceptance tests, not by these stubs.

declare const game: any;
declare const CONFIG: any;
declare const ui: any;
declare const Hooks: any;
declare const foundry: any;
declare const fromUuid: (uuid: string) => Promise<any>;
declare const Roll: any;

interface Window {
  // The injected domain API. Tools reach it via foundry.call(name, args).
  __fvtt: Record<string, (args?: any) => any>;
}
