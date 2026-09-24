/// <reference types="vite/client" />
/// <reference types="@react-router/node" />
import type { SAppNavAttributes } from "@shopify/app-bridge-types";

// @shopify/app-bridge-types augments the global `JSX` namespace, which
// @types/react 19 no longer reads. Expose the App Bridge elements this app
// uses under `React.JSX` so they type-check with React 19.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": SAppNavAttributes;
    }
  }
}
