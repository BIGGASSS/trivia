/// <reference types="vite-plus/client" />

// vue-tsc resolves .vue SFC types natively, but the type-aware lint pass
// (oxlint/tsgolint via `vp lint`) still needs this shim to resolve .vue
// module imports. Remove it once the linter understands SFCs.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
