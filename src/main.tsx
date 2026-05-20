import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import Mascot from "./Mascot";
import "./styles.css";

const label = getCurrentWebviewWindow().label;
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (label === "mascot") {
  // The mascot floats on the desktop — no click-through reset, no main app.
  document.body.classList.add("mascot-window");
  root.render(<Mascot />);
} else {
  // Safety: always start the main window with click-through disabled so the user
  // can never get permanently locked out of it.
  invoke("set_click_through", { enabled: false }).catch(() => {});
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
