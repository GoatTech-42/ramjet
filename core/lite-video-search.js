// Dedicated Shortcut search pagination. Does not alter web feed/player clients.
export function parseVideoPage(data){
 const results=[],tokens=[],seen=new Set(),text=t=>t?.runs?.map(r=>r.text).join('')||t?.simpleText||'';
 const walk=n=>{if(!n||typeof n!=='object')return;const v=n.videoRenderer||n.compactVideoRenderer;if(v){if(/^[\w-]{11}$/.test(v.videoId||'')&&text(v.title)&&text(v.lengthText)&&!seen.has(v.videoId)){seen.add(v.videoId);const by=v.ownerText||v.longBylineText||v.shortBylineText;results.push({id:v.videoId,title:text(v.title),channel:text(by),channelId:by?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId||'',duration:text(v.lengthText),views:text(v.viewCountText)});}return;}const token=n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;if(token)tokens.push(token);Object.values(n).forEach(walk);};walk(data);return{results,token:tokens.at(-1)||null};
}
export function initialVideoData(html){
 const marker=html.indexOf('var ytInitialData = '),start=html.indexOf('{',marker),end=html.indexOf(';</script>',start);
 const version=/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1],visitor=/"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];
 if(marker<0||start<0||end<0||!version)throw Error('video search response unavailable');
 return{data:JSON.parse(html.slice(start,end)),context:{client:{clientName:'WEB',clientVersion:version,hl:'en',gl:'US',...(visitor?{visitorData:visitor}:{})}}};
}
export function createVideoPager({fetchPage,now=Date.now}={}){
 const cache=new Map();return async(q,limit)=>{
  let state=cache.get(q);if(!state||now()-state.at>180000){state={at:now(),items:[],seen:new Set(),token:null,context:null,started:false,done:false,busy:null,pages:0};cache.set(q,state);while(cache.size>50)cache.delete(cache.keys().next().value);}
  let advances=0;
  while(state.items.length<limit&&!state.done){
   if(++advances>6)throw Error('video search page needs too many continuations; try again');
   if(!state.busy)state.busy=(async()=>{const oldToken=state.token;const response=await fetchPage(q,state.started?state.token:null,state.context);const parsed=parseVideoPage(response.data);for(const item of parsed.results)if(!state.seen.has(item.id)){state.seen.add(item.id);state.items.push(item);}state.context=response.context||state.context;state.token=parsed.token;state.started=true;state.pages++;state.done=!parsed.token||parsed.token===oldToken||state.pages>=20;})().finally(()=>{state.busy=null;});
   await state.busy;
  }
  return{items:state.items.slice(0,limit),hasMore:state.items.length>limit||!state.done};
 };
}
const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function read(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error('video search source unavailable');const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>8388608)throw Error('video search response too large');chunks.push(c);}return Buffer.concat(chunks).toString('utf8');}
export const liteVideoSearch=createVideoPager({fetchPage:async(q,token,context)=>{
 if(!token)return initialVideoData(await read('https://www.youtube.com/results?'+new URLSearchParams({search_query:q,hl:'en',gl:'US'}),{headers:{'user-agent':UA}}));
 return{data:JSON.parse(await read('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',{method:'POST',headers:{'content-type':'application/json','user-agent':UA},body:JSON.stringify({context,continuation:token})})),context};
}});
