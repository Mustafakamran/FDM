import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The window starts hidden (tauri.conf.json `visible: false`) so Windows never
// shows its default black backbuffer before WebView2 has painted anything.
// Two rAFs guarantee a real paint has landed before we reveal it, so the
// window appears with themed content already on screen — no flash.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void getCurrentWindow().show().catch(() => {});
  });
});
