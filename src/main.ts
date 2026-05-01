import "./patterns/patterns.css";
import "./styles.css";
import { createApp } from "./ui/app";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root element not found");
}

createApp(app);
