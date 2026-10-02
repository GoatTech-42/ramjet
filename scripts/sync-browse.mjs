// copies the pinned scramjet/epoxy vendor files into the vite public dir
import { mkdirSync, copyFileSync } from "node:fs";
const nm = new URL("../node_modules", import.meta.url).pathname;
const pub = new URL("../web/src/public", import.meta.url).pathname;
const files = [
  ["@mercuryworkshop/scramjet/dist/scramjet.js", "scramjet/scramjet.js"],
  ["@mercuryworkshop/scramjet/dist/scramjet.wasm", "scramjet/scramjet.wasm"],
  ["@mercuryworkshop/scramjet-controller/dist/controller.api.js", "controller/controller.api.js"],
  ["@mercuryworkshop/scramjet-controller/dist/controller.sw.js", "controller/controller.sw.js"],
  ["@mercuryworkshop/scramjet-controller/dist/controller.inject.js", "controller/controller.inject.js"],
  ["@mercuryworkshop/epoxy-transport/dist/index.mjs", "epoxy/index.mjs"],
  ["@mercuryworkshop/libcurl-transport/dist/index.mjs", "libcurl/index.mjs"],
];
for (const [src, dst] of files) {
  mkdirSync(new URL(`../web/src/public/${dst.split("/")[0]}`, import.meta.url).pathname, { recursive: true });
  copyFileSync(`${nm}/${src}`, `${pub}/${dst}`);
}
console.log("browse vendor synced");
