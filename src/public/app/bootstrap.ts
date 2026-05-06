import ReactDOM from "react-dom/client";
import { App } from "./App";

type AppGlobals = { ReactDOM: typeof ReactDOM; App: typeof App };
const g = globalThis as typeof globalThis & AppGlobals;
g.ReactDOM = ReactDOM;
g.App = App;
