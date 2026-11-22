import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Settings lands in S3; S1 ships the tray only.
function App() {
  return <main className="p-6 text-sm">social-tunnel</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
