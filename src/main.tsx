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
// Requires `core:window:allow-show` in capabilities/default.json; if this
// reveal ever fails anyway, the Rust-side failsafe (lib.rs setup) force-shows
// the window after a few seconds so the app can never sit invisible.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch((e) => console.error("window.show() failed (Rust failsafe will reveal):", e));
  });
});
