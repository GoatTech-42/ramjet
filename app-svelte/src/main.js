import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import * as rjEngine from "./lib/rj/engine.js";
export default mount(App, { target: document.getElementById("app") });
