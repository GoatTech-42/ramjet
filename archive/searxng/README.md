# searxng archive (ran as ramjet search, v0.9.0-v0.9.1)

Removed in v0.9.2 - the skin did not meet the bar ("buns... just use duckduckgo").
Kept in case the idea comes back. To revive:

docker run -d --name searxng --restart unless-stopped --memory=400m --memory-swap=400m --cpus=1.0 -p 127.0.0.1:8888:8080 -e UWSGI_WORKERS=2 -e UWSGI_THREADS=2   -v $PWD/archive/searxng/settings.yml:/etc/searxng/settings.yml   -v $PWD/archive/searxng/skin/custom.css:/usr/local/searxng/searx/static/themes/simple/custom.css   -v $PWD/archive/searxng/skin/rj-dart.svg:/usr/local/searxng/searx/static/themes/simple/img/rj-dart.svg   -v $PWD/archive/searxng/skin/index.html:/usr/local/searxng/searx/templates/simple/index.html   -v $PWD/archive/searxng/skin/templates/base.html:/usr/local/searxng/searx/templates/simple/base.html   searxng/searxng:latest

Regenerate secret_key in settings.yml first. The v0.9.0/0.9.1 ramjet-side code (proxy route, engine wiring, accent script) is in git history under tags v0.9.0/v0.9.1.
