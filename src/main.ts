import "./patterns/patterns.css";
import "./styles.css";
import { createApp } from "./ui/app";

/**
 * @file main.ts
 *
 * bm-bluetooth — Browser bootstrap: loads global styling bundles then mounts **`#app`** via {@link createApp}.
 *
 * **Private** repo.
 */

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root element not found");
}

createApp(app);
