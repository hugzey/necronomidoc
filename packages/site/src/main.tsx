import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import { injectedData } from "./api.js";
import { FileView, Home, Layout, RepoView } from "./pages.js";
import "./styles.css";

// Static single-file exports can't rely on server-side SPA fallback, so they
// use hash routing; the served site keeps clean URLs.
const Router = injectedData() ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/r/:slug" element={<RepoView />} />
          <Route path="/r/:slug/f/*" element={<FileView />} />
        </Route>
      </Routes>
    </Router>
  </StrictMode>,
);
