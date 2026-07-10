import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { FileView, RepoList, RepoView } from "./pages.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RepoList />} />
        <Route path="/r/:slug" element={<RepoView />} />
        <Route path="/r/:slug/f/*" element={<FileView />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
