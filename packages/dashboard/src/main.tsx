import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { registerDashboardPlugins } from "./plugins.js";
import "./app.css";

// Plugin frontends register their settings sections / nav items /
// composer slots / etc. into the dashboard registry BEFORE the React
// tree mounts. By the time <App> renders, the registry already
// contains everything; existing layouts pick it up naturally.
registerDashboardPlugins();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
