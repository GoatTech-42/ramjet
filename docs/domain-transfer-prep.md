# lukeevanson.com move prep (read-only research, updated Fri Oct 2 2026 8:03 AM)
Luke: website moves to Cloudflare Pages, x10hosting is dropped, domain transfers this weekend, mail is not used. NO DNS or registrar changes made. Cloudflare migration todo stays on hold until Luke says go.

## Current records (live lookups)
- NS ns1/ns2.x10hosting.com (DNS hosted at x10)
- apex A + www A 198.91.81.11 (x10 website)
- server A 50.47.252.113 and bedrock A 50.47.252.113 (home box)
- MX 10 mail.lukeevanson.com, SPF TXT (x10 mail; Luke does not use it, OK to lose)
- No SRV records. No mc/play records.

## What depends on the name
- Ramjet preview link server.lukeevanson.com:4201 (srv.us tunnel link is independent)
- 4b4t join address server.lukeevanson.com default ports (A record only)
- Crafty panel server.lukeevanson.com:8443
- Website at apex/www (moves to Pages)
- Does NOT depend on it: srv.us tunnels, Emberstead playit tunnels.

## Steps (Luke approves each; I change nothing until told)
1. Export from x10 first: full zone file (screenshot too), and the site files (public_html) so Pages has the source. Mail export optional since unused.
2. On Cloudflare: add the site, let it scan records. BEFORE switching nameservers verify these exist as DNS-only (grey cloud, NOT proxied): A server -> 50.47.252.113, A bedrock -> 50.47.252.113. Proxying would break Minecraft, Crafty :8443 and ramjet :4201 (Cloudflare proxy only passes a few ports and no game traffic).
3. Create the Pages project from the exported site files, attach apex and www as custom domains (Cloudflare will create those records itself; delete the old 198.91.81.11 A records).
4. Drop MX and the SPF TXT, or leave them, harmless. Skip DKIM/DMARC.
5. Transfer the registration to Cloudflare Registrar (unlock at current registrar, get auth code, approve the transfer email). With Cloudflare as registrar the nameservers are Cloudflare anyway, so no nameserver gap if the zone is ready first.
6. Verify: dig server.lukeevanson.com = 50.47.252.113, ramjet :4201, Crafty :8443, Java join and Bedrock join on 4b4t, website loads from Pages.
7. Then resume the Cloudflare migration todo (tunnels etc). Ramjet tunnel stays srv.us.

## What could break
- Zone not ready at the moment nameservers switch: server/bedrock vanish, taking ramjet link, 4b4t join address and Crafty URL (hours of cache lag). Fallbacks: srv.us link for ramjet, direct IP 50.47.252.113 for Minecraft.
- Cloudflare proxying (orange cloud) turned on for server/bedrock breaks non-HTTP ports.
- Turning x10 off before the site files are exported loses the site.
- Home IP change: A record is manual, update if the home IP changes.

## Target layout (Luke, relayed 8:03 AM): apex/www on Pages, server.lukeevanson.com with per-service sub-subdomains
Cloudflare facts (checked in docs, Oct 2 2026):
- Proxied (orange cloud) HTTPS only works on ports 443, 2053, 2083, 2087, 2096, 8443. So 4201 (ramjet) cannot be proxied as is. 8443 (Crafty) can.
- Minecraft Java 25565, Bedrock 19132 (UDP) and voice 24454 can never be proxied. Must be DNS-only.
- Free Universal SSL covers the apex and ONE level (blog.example.com). Two levels (ramjet.server.lukeevanson.com) get NO valid cert when proxied (needs the paid Advanced Certificate Manager).

## Records for the layout
- A server -> 50.47.252.113, DNS-only (Java 25565, Bedrock 19132, voice 24454 reach the box on the default ports, so no SRV needed)
- apex + www -> Pages (Cloudflare adds these)
- mc.server / bedrock.server style names: CNAME or A to 50.47.252.113, DNS-only. Fine for game traffic, because DNS-only does not need a cert. Players type mc.server.lukeevanson.com.
- ramjet.server / crafty.server (web): DNS-only works only if the box itself serves a valid cert for that exact name on 443 (reverse proxy, e.g. Caddy with a Let us Encrypt DNS-01 cert), and router forwards 443. Proxied does NOT work (no cert at two levels, and 4201 is not a proxied port).

## Simplest approach that works (recommended)
1. Keep game traffic on DNS-only names under server (server, mc.server, bedrock.server). No change for players.
2. Make the WEB services one level deep, not two: ramjet.lukeevanson.com and crafty.lukeevanson.com. Free cert covers them.
   - Easiest for both: a Cloudflare Tunnel (cloudflared on the box) per hostname. No port forwarding, no port in the URL, valid cert, hides the home IP. Tunnel maps ramjet.lukeevanson.com -> http://127.0.0.1:4201 and crafty.lukeevanson.com -> https://127.0.0.1:8443 (no-TLS-verify).
   - Alternative for Crafty only: proxied A crafty.lukeevanson.com on port 8443 works as is, since 8443 is a supported port.
3. Do not nest ramjet/crafty under server. It forces either a paid cert or a reverse proxy plus cert renewal on the box for no benefit.
4. Standing rule: the srv.us ramjet tunnel stays until Luke decides to retire it. A Cloudflare tunnel for ramjet would be additive and is his call.

## What Luke needs to do (when ready, nothing done yet)
- Make a Cloudflare account, add lukeevanson.com, create the zone records above, then transfer registration.
- Decide: flat names (recommended) or nested names with a box-side reverse proxy.
- If tunnels: I install cloudflared on the box and create them with a token he creates in the dashboard. The token goes into the vault or a file on the box, never in chat.
