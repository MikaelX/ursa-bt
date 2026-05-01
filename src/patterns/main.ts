import "../styles.css";
import "./patterns.css";
import { renderPatternLibrary } from "./page";

const root = document.querySelector<HTMLDivElement>("#patterns");
if (!root) throw new Error("Pattern library root not found");

renderPatternLibrary(root);
