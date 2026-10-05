"""Brave images engine for ramjet. Upstream brave.py can't parse Brave's page any more
(data is now a JS function call with arguments), so the embedded data expression is
evaluated by node in an empty vm sandbox."""
import json, subprocess
from urllib.parse import urlencode
from searx.exceptions import SearxEngineResponseException
from searx.result_types import EngineResults
from searx.result_types.image import Image

about = {"website": "https://search.brave.com/", "use_official_api": False, "require_api_key": False, "results": "HTML"}
base_url = "https://search.brave.com/"
categories = ["images"]
paging = False
safesearch = True
time_range_support = False
safesearch_map = {2: "strict", 1: "moderate", 0: "off"}

JS = r'''
let t = require("fs").readFileSync(0, "utf8");
const k = t.indexOf("kit.start"); const i = t.indexOf("data: [", k); const m = /\n\s*form:/.exec(t.slice(i)); const j = m ? i + m.index : -1;
if (k < 0 || i < 0 || j < 0) { console.log("null"); process.exit(0); }
let e = t.slice(i + 6, j).trim().replace(/,$/, "");
const d = require("vm").runInNewContext("(" + e + ")", Object.create(null), { timeout: 3000 });
console.log(JSON.stringify(d));
'''


def request(query, params):
    params["url"] = base_url + "images?" + urlencode({"q": query, "source": "web"})
    params["headers"]["Accept-Encoding"] = "gzip, deflate"
    params["cookies"]["safesearch"] = safesearch_map.get(params["safesearch"], "off")
    params["cookies"]["useLocation"] = "0"
    params["cookies"]["summarizer"] = "0"
    params["cookies"]["country"] = "us"
    params["cookies"]["ui_lang"] = "en-us"


def response(resp):
    out = subprocess.run(["node", "-e", JS], input=resp.text.encode("utf-8"), capture_output=True, timeout=8)
    if out.returncode != 0 or not out.stdout.strip():
        raise SearxEngineResponseException("brave: node eval failed")
    data = json.loads(out.stdout)
    if not data:
        raise SearxEngineResponseException("brave: data block not found")
    results = EngineResults()
    try:
        d = data[1]["data"]
        if d.get("noResults"):
            return results
        items = d["body"]["response"]["results"]
    except (KeyError, IndexError, TypeError) as e:
        raise SearxEngineResponseException("brave: unexpected structure") from e
    for r in items:
        props = r.get("properties") or {}
        th = r.get("thumbnail") or {}
        if not props.get("url"):
            continue
        w, h = props.get("width"), props.get("height")
        results.add(Image(title=r.get("title", ""), url=r.get("url"), img_src=props.get("url", ""),
                          thumbnail_src=th.get("src", "") if th else "", source=r.get("source", ""),
                          resolution=f"{w}x{h}" if w and h else ""))
    return results
