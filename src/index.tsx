/* @refresh reload */
import { render } from "solid-js/web";
import { initTheme } from "./lib/store";
import "./index.css";
import App from "./App";

// 先落主题属性，避免首屏闪色
initTheme();

render(() => <App />, document.getElementById("root") as HTMLElement);
