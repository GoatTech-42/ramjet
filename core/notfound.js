// the 404 for unknown pages: the ramjet look with the tokens inlined (the
// page must render with zero other requests), and a way back home. dark is
// the default to match :root in tokens.css; light rides the media query.
export function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nothing here - ramjet</title>
<style>
:root { color-scheme: dark; --bg: #111318; --surface: #1d2027; --border: #393e49; --text: #f3f5fa; --dim: #c1c7d2; --accent: #85b7ff; --ink: #101d33; }
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; --bg: #f3f5f9; --surface: #fcfdff; --border: #ccd3df; --text: #192332; --dim: #455268; --accent: #145ecb; --ink: #ffffff; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
.card { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: 28px; padding: 44px; box-shadow: 0 24px 80px rgba(4,8,18,.2); }
.mark { margin: 0 0 28px; font-size: 24px; font-weight: 800; letter-spacing: -.04em; }
.mark i { color: var(--accent); font-style: normal; }
h1 { margin: 0 0 10px; font-size: 30px; font-weight: 700; letter-spacing: -.035em; }
.sub { margin: 0 0 28px; font-size: 15px; line-height: 1.6; color: var(--dim); }
.home { display: block; text-align: center; background: var(--accent); color: var(--ink); text-decoration: none; font-weight: 600; font-size: 15px; border-radius: 14px; padding: 13px 20px; }
.home:hover { filter: brightness(1.06); }
.home:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
</style>
</head>
<body>
<main class="card">
<p class="mark">ramjet<i>.</i></p>
<h1>Nothing here</h1>
<p class="sub">That page wandered off. The rest of your corner of the web is right where you left it.</p>
<a class="home" href="/">back home</a>
</main>
</body>
</html>`;
}
