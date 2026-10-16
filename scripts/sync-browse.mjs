// copies the pinned scramjet/epoxy vendor files into the vite public dir
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
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

// Pinned Scramjet coerces absent/null History URL arguments into relative URLs.
// Native History leaves the current URL unchanged in these two cases.
const vendor = `${pub}/scramjet/scramjet.js`;
const historyOld = 'let r=e.box.histories.get(t.this),s=(0,n.Qf)(t.args[2]);';
const historyNew = 'if(t.args[2]==null)return t.call();'+historyOld;
const source = readFileSync(vendor,'utf8');
if(source.split(historyOld).length!==2)throw new Error('pinned Scramjet History patch no longer matches; review vendor');

// Preserve X-Content-Type-Options for script destinations. Pinned Scramjet
// strips nosniff from every proxied response, so an origin serving
// text/plain + nosniff (specifically to forbid script execution) gets its
// bytes executed through the proxy. With the header kept, chrome refuses
// non-JS script types; no-nosniff wrong types keep executing as before.
const sniffOld = 'for(let e of o)s.delete(e);';
const sniffNew = 'for(let e of o){if("x-content-type-options"===e&&s.has(e)&&["script","worker","sharedworker"].includes(r.destination))continue;s.delete(e)}';
if(source.split(sniffOld).length!==2)throw new Error('pinned Scramjet nosniff patch anchor no longer matches; review vendor');
writeFileSync(vendor,source.replace(historyOld,historyNew).replace(sniffOld,sniffNew));
