#!/bin/bash
# ROOT: dir containing ramjetd ELF, dist trees, data/, auth.db, node deps. Override with LAB_ROOT.
ROOT="${LAB_ROOT:-/tmp/fullapp}"
# runs entirely inside: unshare -Urmn  (fresh net ns: lo up, 8080 free)
set -x
mount --bind $ROOT/hosts /etc/hosts
python3 - <<'PY'
import socket,fcntl,struct
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
ifr=struct.pack('16sh',b'lo',0)
f=struct.unpack('16sh',fcntl.ioctl(s,0x8913,ifr))[1]
fcntl.ioctl(s,0x8914,struct.pack('16sh',b'lo',f|0x1|0x40))
print('lo up')
PY
cd "$ROOT"
NODE_PATH=$ROOT/node/node_modules node $ROOT/fixture_srv.js > fixture.log 2>&1 &
NODE_PATH=$ROOT/node/node_modules node $ROOT/sidecar.js > wisp.log 2>&1 &
env RJ_DATA=$ROOT/data RJ_DIST="$DIST" RJ_AUTH_DB=$ROOT/auth.db RJ_HOST=127.0.0.1 RJ_PORT=14224 RJ_TEST_MODE=1 ./ramjetd > backend.log 2>&1 &
for i in $(seq 1 20); do curl -s -m1 -o /dev/null http://127.0.0.1:14224/healthz && break; sleep 0.5; done
echo "healthz: $(curl -s -m2 http://127.0.0.1:14224/healthz)"
echo "fixture: $(curl -s -m2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/)"

echo "=== sync probe ==="
curl -s -m3 -b /tmp/fullapp/jar.txt -o /tmp/fullapp/sync_get.txt -w 'GET %{http_code}\n' http://127.0.0.1:14224/api/apps/browse/sync
curl -s -m3 -b /tmp/fullapp/jar.txt -H 'x-ramjet-js: 1' -H 'Content-Type: application/json' -d '{}' -o /tmp/fullapp/sync_post.txt -w 'POST %{http_code}\n' http://127.0.0.1:14224/api/apps/browse/sync
echo "get body: $(cat /tmp/fullapp/sync_get.txt)"; echo "post body: $(cat /tmp/fullapp/sync_post.txt)"
NODE_PATH=$ROOT/node/node_modules timeout 100 node $ROOT/harness.js "$MODE"
echo "harness exit: $?"
