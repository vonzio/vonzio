import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { registerDashboardPlugins } from "./plugins.js";
import { registerPublicRoute } from "./public-routes.js";
import { ChatEmbed } from "./ChatEmbed.js";
import "./app.css";

// Plugin frontends register their settings sections / nav items /
// composer slots / etc. into the dashboard registry BEFORE the React
// tree mounts. By the time <App> renders, the registry already
// contains everything; existing layouts pick it up naturally.
registerDashboardPlugins();

// The embeddable chat page (/chat) is a public surface — the widget's iframe
// loads it. Registered via the public-route seam before App mounts.
registerPublicRoute({ path: "/chat", element: <ChatEmbed /> });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
