import { createRoot } from "react-dom/client";
import { createApp } from "./app/createApp";
import { handleOAuthPopup } from "./providers/browser/browserStreaming";
import { AppRoot } from "./ui/App";
import "./ui/styles.css";

// A streaming sign-in popup returning to this page only hands back its result.
if (!handleOAuthPopup()) {
  // The engine graph is created outside React so re-renders, HMR or UI errors
  // can never tear down audio or controller handling.
  const app = createApp();
  (window as unknown as { dbdj: typeof app }).dbdj = app; // devtools access for debugging

  createRoot(document.getElementById("root")!).render(<AppRoot app={app} />);
}
