import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./styles.css";

// Safety: always start with click-through disabled so the user can never get
// permanently locked out of the window. UI re-enables it on demand.
invoke("set_click_through", { enabled: false }).catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
