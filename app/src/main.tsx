import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installFonts } from "./fonts";
import { isAndroid } from "./platform";

if (isAndroid) document.documentElement.classList.add("is-android");

installFonts();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
