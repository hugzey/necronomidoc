import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import { injectedData } from "./api.js";
import {
  ArtefactsView,
  CoreDocView,
  FileView,
  Home,
  Layout,
  RepoView,
  SkillSetView,
  SkillsView,
  StatusView,
  SubsystemsView,
} from "./pages.js";
import { HelpView } from "./help.js";
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
          <Route path="/status" element={<StatusView />} />
          {/* The splat also matches bare /help (empty splat → index page). */}
          <Route path="/help/*" element={<HelpView />} />
          <Route path="/skills" element={<SkillsView />} />
          <Route path="/skills/:id" element={<SkillSetView />} />
          <Route path="/artefacts" element={<ArtefactsView />} />
          <Route path="/r/:slug" element={<RepoView />} />
          <Route path="/r/:slug/docs" element={<CoreDocView />} />
          <Route path="/r/:slug/docs/:kind" element={<CoreDocView />} />
          <Route path="/r/:slug/subsystems" element={<SubsystemsView />} />
          <Route path="/r/:slug/f/*" element={<FileView />} />
        </Route>
      </Routes>
    </Router>
  </StrictMode>,
);
