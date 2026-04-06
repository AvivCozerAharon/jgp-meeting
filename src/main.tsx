// main.tsx
// Ponto de entrada da aplicação React do JGP Meeting.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ComplianceOverlay } from "./components/ComplianceOverlay";
import "./index.css";

const isComplianceWindow = window.location.hash === "#compliance";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isComplianceWindow ? <ComplianceOverlay /> : <App />}
  </React.StrictMode>
);
