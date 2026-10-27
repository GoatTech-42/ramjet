import json, base64, os, random, subprocess, shutil
random.seed(7)
FX = {}; S = []
def canon(o): return json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def it(web, ep, body, js=None, status=200, throw=False):
    k = f"IT|{'web' if web else 'android'}|{ep}|{canon(body)}"
    FX[k] = {'throw': True} if throw else {'json': js, 'status': status}
def yd(url, js=None, end=None, err=None):
    k = 'YD|' + url + (f'|end={end}' if end else '')
    FX[k] = {'error': err} if err else {'json': js}
def raw(url, data=b'', status=200, ct='image/jpeg', throw=False):
    if not throw and len(data) > 100000 and len(set(data)) == 1: FX['GET|' + url] = {'rep': [data[0], len(data)], 'status': status, 'ct': ct}; return
    FX['GET|' + url] = {'throw': True} if throw else {'b64': base64.b64encode(data).decode(), 'status': status, 'ct': ct}
def step(sub, now=10**12, method='GET', user='luke', setup=None):
    S.append(dict(sub=sub, now=now, method=method, user=user, **({'setup': setup} if setup else {})))
def T(s): return {'runs': [{'text': s}]}
def vr(id, title, ln='3:21', ch='Chan', cid='UCaaaaaaaaaaaaaaaaaaaaaa', views='1,234 views', pub='2 days ago', desc=None, compact=False):
    v = {'videoId': id, 'title': T(title), 'ownerText': {'runs': [{'text': ch, 'navigationEndpoint': {'browseEndpoint': {'browseId': cid}}}]}, 'viewCountText': {'simpleText': views}, 'publishedTimeText': {'simpleText': pub}}
    if ln: v['lengthText'] = {'simpleText': ln}
    if desc: v['descriptionSnippet'] = T(desc)
    return {'compactVideoRenderer' if compact else 'videoRenderer': v}
def cont(tok): return {'continuationItemRenderer': {'continuationEndpoint': {'continuationCommand': {'token': tok}}}}
TOK = 'T' * 30 + 'abc_-=.'
NEXT = 'N' * 40
# ---- search ----
web1 = {'contents': {'twoColumnSearchResultsRenderer': {'primaryContents': {'sectionListRenderer': {'contents': [
    {'itemSectionRenderer': {'contents': [vr('sss0000000a', 'First <b> result & "quotes" é😀'), vr('sss0000000b', 'No length live', ln=None), vr('sss0000000a', 'dup of first'), vr('sss0000000c', 'Third', desc='snip'), {'shelfRenderer': {'content': {'x': [vr('sss0000000d', 'nested', compact=True)]}}}]}},
    cont('IGNOREDsmall'), cont(TOK)]}}}}}
it(True, 'search', {'query': 'cats', 'params': 'EgIQAQ=='}, web1)
step('/search?q=cats'); step('/search?q=%20cats%20')
web2 = {'onResponseReceivedCommands': [{'appendContinuationItemsAction': {'continuationItems': [{'itemSectionRenderer': {'contents': [vr('ttt0000000a', 'page two')]}}, cont(NEXT)]}}]}
it(True, 'search', {'continuation': TOK}, web2)
step('/search?q=cats&token=' + TOK.replace('%2B', '%252B') if False else '/search?q=cats&token=' + TOK)
step('/search?q=cats&token=short'); step('/search?q=&type=x'); step('/search?q=' + 'x' * 121); step('/search?q=' + 'x' * 120 + '&type=channel')
# web empty -> android fallback
it(True, 'search', {'query': 'empty', 'params': 'EgIQAQ=='}, {'contents': {}})
it(False, 'search', {'query': 'empty'}, {'x': [vr('aaa0000000a', 'android one', compact=True)] * 2 + [vr('aaa0000000b', 'android two')]})
step('/search?q=empty')
it(True, 'search', {'query': 'webdown', 'params': 'EgIQAQ=='}, throw=True)
it(False, 'search', {'query': 'webdown'}, {'x': [vr('aaa0000000c', 'fallback after throw')]})
step('/search?q=webdown')
it(True, 'search', {'query': 'bothdown', 'params': 'EgIQAQ=='}, status=500)
it(False, 'search', {'query': 'bothdown'}, throw=True)
step('/search?q=bothdown')
it(True, 'search', {'continuation': 'C' * 25}, status=503)
step('/search?q=cats&token=' + 'C' * 25)
# 25+ unique results in web page to test cap 40 / android cap 20
many = [vr('mmm%08d' % i, 'm%d' % i) for i in range(45)]
it(True, 'search', {'query': 'many', 'params': 'EgIQAQ=='}, {'contents': {'twoColumnSearchResultsRenderer': {'primaryContents': {'sectionListRenderer': {'contents': [{'itemSectionRenderer': {'contents': many}}]}}}}})
step('/search?q=many')
it(False, 'search', {'query': 'many2'}, {'x': many}); it(True, 'search', {'query': 'many2', 'params': 'EgIQAQ=='}, {})
step('/search?q=many2')
# kind searches
ch = lambda i, n, sub='@h%d' % 0, vc=None, th=2: {'channelRenderer': {'channelId': 'UC' + ('%022d' % i), 'title': {'simpleText': n}, 'subscriberCountText': {'simpleText': sub}, 'videoCountText': T(vc) if vc else None, 'descriptionSnippet': T('about ' + n), 'thumbnail': {'thumbnails': [{'url': '//yt3.ggpht.com/a%d=s88' % i}, {'url': '//yt3.ggpht.com/b%d=s176' % i}][:th]}}}
chs = {'contents': [ch(1, 'Alpha', '@alpha', '12 videos'), ch(2, 'Beta', '1.2M subscribers'), ch(1, 'Alpha dup'), {'channelRenderer': {'channelId': 'bad', 'title': T('bad')}}, ch(3, 'Gamma', '@g', None, 0)]}
it(True, 'search', {'query': 'chan', 'params': 'EgIQAg=='}, chs)
step('/search?q=chan&type=channel')
pl = lambda id, t, ch_, cnt, vid: {'lockupViewModel': {'contentType': 'LOCKUP_CONTENT_TYPE_PLAYLIST', 'contentId': id, 'contentImage': {'collectionThumbnailViewModel': {'primaryThumbnail': {'thumbnailViewModel': {'image': {'sources': [{'url': f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg'}]}, 'overlays': [{'thumbnailOverlayBadgeViewModel': {'thumbnailBadges': [{'thumbnailBadgeViewModel': {'text': cnt}}]}}]}}}}, 'metadata': {'lockupMetadataViewModel': {'title': {'content': t}, 'metadata': {'contentMetadataViewModel': {'metadataRows': [{'metadataParts': [{'text': {'content': ch_}}]}]}}}}}}
pls = {'a': [pl('PLabcdefghij1', 'List One', 'Chan A', '12 videos', 'vvv0000000a'), pl('PLabcdefghij1', 'dup', 'x', '', ''), pl('XXabcdefghij1', 'badprefix', '', '', ''), pl('RDabcdefghijk2', 'Mix', '', '', 'nope'), {'lockupViewModel': {'contentType': 'VIDEO', 'contentId': 'PLzzzzzzzzzz'}}]}
it(True, 'search', {'query': 'plist', 'params': 'EgIQAw=='}, pls)
step('/search?q=plist&type=playlist')
it(True, 'search', {'query': 'kdown', 'params': 'EgIQAg=='}, throw=True)
step('/search?q=kdown&type=channel')
# ---- channel tabs ----
CID = 'UC' + 'a' * 22
def ent(i, title='t', dur=300, ch_=None, views=1234567): 
    e = {'id': 'cv%09d' % i, 'title': '%s%d' % (title, i), 'duration': dur, 'view_count': views}
    if ch_: e['channel'] = ch_
    return e
videos = [ent(1, dur=125), ent(2, dur=3725.4, ch_='Other Name'), ent(3, dur=61), ent(4, dur=62), ent(5, dur=None, views=None), ent(6, dur=0), ent(7, dur=45), {'id': 'cvNOTITLE00', 'duration': 99}, None, ent(9, dur=600, views=0), ent(10, dur=59.5)]
shorts = [ent(3, dur=61), ent(7, dur=45), ent(10, dur=59.5), ent(11, dur=20), ent(12, dur=100), ent(13, dur=None)]
yd(f'https://www.youtube.com/playlist?list=UU{CID[2:]}', {'channel': 'Chan "Q"', 'uploader': 'up', 'title': 'Uploads from Zed', 'entries': videos})
yd(f'https://www.youtube.com/channel/{CID}/shorts', {'uploader': 'ShortUp', 'entries': shorts})
dead = {'ids': ['cv000000009']}
step(f'/channel?id={CID}', setup={'jetstream-dead.json': dead})
step(f'/channel?id={CID}&tab=shorts'); step(f'/channel?id={CID}&tab=nope'); step(f'/channel?id={CID}', now=10**12 + 31 * 60000)
step('/channel?id=x'); step('/channel?id=' + 'a' * 65); step('/channel')
CID2 = 'UC' + 'b' * 22
yd(f'https://www.youtube.com/playlist?list=UU{CID2[2:]}', {'title': 'Uploads from Only Videos', 'entries': [ent(21, dur=500)]})
yd(f'https://www.youtube.com/channel/{CID2}/shorts', err='ERROR: shorts tab missing')
step(f'/channel?id={CID2}')
CID3 = 'UC' + 'c' * 22
yd(f'https://www.youtube.com/playlist?list=UU{CID3[2:]}', err='ERROR: boom')
step(f'/channel?id={CID3}'); step(f'/channel?id={CID3}&tab=shorts')
CID4 = 'UC' + 'd' * 22
yd(f'https://www.youtube.com/playlist?list=UU{CID4[2:]}', None)
step(f'/channel?id={CID4}')
# ---- channel info ----
INFO = 'UC' + 'e' * 22
brow = {'metadata': {'channelMetadataRenderer': {'title': 'Info Chan', 'description': 'd' * 3100, 'avatar': {'thumbnails': [{'url': 'https://yt3.ggpht.com/av0'}, {'url': 'https://yt3.ggpht.com/av1'}]}}},
        'header': {'pageHeaderRenderer': {'content': {'pageHeaderViewModel': {'metadata': {'contentMetadataViewModel': {'metadataRows': [{'metadataParts': [{'text': {'content': '@infochan'}}, {'text': {'content': '1.5M subscribers'}}, {'text': {'content': '300 videos'}}]}]}},
        'banner': {'imageBannerViewModel': {'image': {'sources': [{'url': '//yt3.googleusercontent.com/small', 'width': 300}, {'url': '//yt3.googleusercontent.com/big', 'width': 1060}]}}}}}}}}
it(True, 'browse', {'browseId': INFO}, brow)
step(f'/channel/info?id={INFO}'); step(f'/channel/info?id={INFO}', now=10**12 + 5000)
INFO2 = 'UC' + 'f' * 22
it(True, 'browse', {'browseId': INFO2}, {'metadata': {}})
step(f'/channel/info?id={INFO2}')
INFO3 = 'UC' + 'g' * 22
it(True, 'browse', {'browseId': INFO3}, {'metadata': {'channelMetadataRenderer': {'title': 'Tiny'}}, 'header': {'pageHeaderRenderer': {'content': {'pageHeaderViewModel': {'banner': {'imageBannerViewModel': {'image': {'sources': [{'url': '//x/one', 'width': 100}, {'url': 'https://x/two', 'width': 200}]}}}}}}}})
step(f'/channel/info?id={INFO3}')
INFO4 = 'UC' + 'h' * 22
it(True, 'browse', {'browseId': INFO4}, status=404)
step(f'/channel/info?id={INFO4}'); step('/channel/info?id=UCshort')
# ---- channel playlists ----
yd(f'https://www.youtube.com/channel/{CID}/playlists', {'entries': [
    {'id': 'PLabcdefghij1', 'title': 'P1', 'thumbnails': [{'url': 'https://x/nope'}, {'url': 'https://i.ytimg.com/vi/pppppppppp1/hq.jpg?x'}]},
    {'id': 'PLabcdefghij2', 'title': 'P2'}, {'id': 'XXabcdefghij3', 'title': 'bad'}, {'id': 'FLabcdefghij4'}, {'id': 'OLabcdefghij5', 'title': 'O5', 'thumbnails': []}]})
step(f'/channel/playlists?id={CID}')
yd(f'https://www.youtube.com/channel/{CID2}/playlists', err='ERROR: This channel does not have a playlists tab')
step(f'/channel/playlists?id={CID2}')
yd(f'https://www.youtube.com/channel/{CID3}/playlists', err='ERROR: other failure')
step(f'/channel/playlists?id={CID3}'); step('/channel/playlists?id=bad')
# ---- playlist + checkMany ----
def vid(n): return 'pv%09d' % n
PL = 'PL' + 'p' * 12
entries = []
for n in range(1, 31):
    entries.append({'id': vid(n), 'title': 'Vid %d Zed' % n, 'channel': 'Chan %d' % (n % 3), 'channel_id': 'UC' + 'z' * 22 if n % 2 else 'xx', 'duration': 60 + n * 13, 'view_count': n * 1000})
entries += [{'id': vid(5), 'title': 'dup5 later', 'duration': 1}, {'id': vid(40), 'title': '[Private video]'}, {'id': vid(41), 'title': '[Deleted video]'}, {'id': vid(42), 'title': 'adult', 'age_limit': 18}, {'id': vid(43), 'title': 'prem', 'availability': 'premium_only'}, {'id': vid(44), 'title': 'ok avail', 'availability': 'public'}, {'id': 'short', 'title': 'badid'}, {'id': vid(45)}, {'id': vid(46), 'title': 'deadone'}]
yd(f'https://www.youtube.com/playlist?list={PL}', {'title': 'Playlist Title', 'channel': 'PL Chan', 'channel_id': 'UC' + 'y' * 22, 'playlist_count': 77, 'entries': entries}, end=3000)
def player(n, st=None, code=200, throw=False):
    it(False, 'player', {'videoId': vid(n), 'contentCheckOk': False, 'racyCheckOk': False}, {'playabilityStatus': {'status': st}} if st else {'noStatus': 1}, status=code, throw=throw)
for n in list(range(1, 31)) + [44]:
    if n % 7 == 3: player(n, 'LOGIN_REQUIRED')
    elif n % 11 == 5: player(n, throw=True)
    elif n % 13 == 4: player(n, 'OK', code=500)
    elif n == 9: player(n, 'UNPLAYABLE')
    elif n == 12: player(n, 'AGE_CHECK_REQUIRED')
    elif n == 15: player(n, 'LIVE_STREAM_OFFLINE')
    elif n == 16: player(n, 'WEIRD_NEW_STATUS')
    elif n == 17: player(n, None)
    else: player(n, 'OK')
NOW = 10**12 + 100
step('/playlist?id=' + PL, now=NOW, setup={'jetstream-dead.json': {'ids': [vid(46), vid(2)]}})
step('/playlist?id=' + PL + '&offset=10&limit=10', now=NOW + 1)
step('/playlist?id=' + PL + '&limit=500', now=NOW + 2)
step('/playlist?id=' + PL + '&limit=0&offset=-3', now=NOW + 2)
step('/playlist?id=' + PL + '&q=VID%201&rev=1', now=NOW + 3)
step('/playlist?id=' + PL + '&all=1', now=NOW + 4)
step('/playlist?id=' + PL + '&offset=999', now=NOW + 5)
step('/playlist?id=' + PL + '&limit=abc&offset=x', now=NOW + 5)
step('/playlist?id=' + PL + '&all=1', now=NOW + 31 * 86400000)   # blocked entries and caches expire
step('/playlist?id=bad'); step('/playlist?id=PLshort')
PL2 = 'PL' + 'q' * 12
yd(f'https://www.youtube.com/playlist?list={PL2}', err='ERROR: private', end=3000)
step('/playlist?id=' + PL2)
PL3 = 'LL' + 'r' * 12
yd(f'https://www.youtube.com/playlist?list={PL3}', {'entries': []}, end=3000)
step('/playlist?id=' + PL3)
# ---- subs/new ----
subs = {'luke': [{'id': CID, 'name': 'Sub Name', 'ts': 5}, {'id': CID2, 'name': 'Second', 'ts': 4}, {'id': CID3, 'name': 'Failing', 'ts': 3}, {'id': 'UC' + 'b' * 22, 'name': 'dupsub', 'ts': 2}]}
hist = {'luke': [{'id': 'cv000000001', 'title': 'seen', 'channel': '', 'duration': '2:05', 'secs': 125, 'completed': False, 'at': 1}]}
step('/subs/new', user='nosubs', setup={'jetstream-subs.json': subs, 'jetstream-history.json': hist})
step('/subs/new', now=NOW + 7 * 60000)
step('/subs/new', now=NOW + 9 * 3600000)
# ---- avatar ----
def blob(n, seed): r = random.Random(seed); return bytes(r.getrandbits(8) for _ in range(n))
A1 = 'https://yt3.ggpht.com/ok1=s88'; raw(A1, blob(900, 1), ct='image/png')
A2 = 'https://yt3.googleusercontent.com/ok2'; raw(A2, blob(500, 2), ct='')
A3 = 'https://yt3.ggpht.com/big'; raw(A3, bytes([7]) * 1500001)
A4 = 'https://yt3.ggpht.com/missing'; raw(A4, b'', status=404)
A5 = 'https://yt3.ggpht.com/boom'; raw(A5, throw=True)
A6 = 'https://yt3.ggpht.com/edge'; raw(A6, bytes([9]) * 1500000)
from urllib.parse import quote
for u in [A1, A1, A2, A3, A4, A5, A6, 'http://yt3.ggpht.com/x', 'https://evil.example/x', 'https://yt3.ggpht.com.evil.example/x', 'not a url', '', 'https://YT3.GGPHT.COM/ok1=s88']:
    step('/avatar?u=' + quote(u, safe=''))
step('/avatar')
# ---- thumb ----
def thumb(id, name, n, seed=9, status=200, throw=False): raw(f'https://i.ytimg.com/vi/{id}/{name}.jpg', blob(n, seed), status=status, throw=throw)
t1 = 'th000000001'; thumb(t1, 'maxresdefault', 20000, 1)
t2 = 'th000000002'; thumb(t2, 'maxresdefault', 5999, 2); thumb(t2, 'sddefault', 6000, 3)
t3 = 'th000000003'; thumb(t3, 'maxresdefault', 100, 4, status=404); thumb(t3, 'sddefault', 100, 5); thumb(t3, 'hqdefault', 100, 6, throw=True); thumb(t3, 'mqdefault', 100, 7)
t4 = 'th000000004'; thumb(t4, 'maxresdefault', 100, 8, status=404)
t5 = 'th000000005'; thumb(t5, 'hqdefault', 7000, 9); thumb(t5, 'mqdefault', 8000, 10)
t6 = 'th000000006'; thumb(t6, 'hqdefault', 3000, 11); thumb(t6, 'mqdefault', 4000, 12)
for sub in [f'/thumb?id={t1}', f'/thumb?id={t1}', f'/thumb?id={t2}', f'/thumb?id={t3}', f'/thumb?id={t4}', f'/thumb?id={t4}', f'/thumb?id={t5}&lite=1', f'/thumb?id={t5}', f'/thumb?id={t6}&lite=1', f'/thumb?id={t1}&lite=1', '/thumb?id=short', '/thumb']:
    step(sub)
json.dump(FX, open('fixtures.json', 'w')); json.dump(S, open('scenarios.json', 'w'))
print(len(FX), len(S))
