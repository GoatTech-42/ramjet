// Epoxy is only needed for tunneled remote WebSockets on the default HTTP path.
export function lazySocketTransport(load){
 let pending;
 const ready=()=>pending||(pending=load().catch(e=>{pending=null;throw e;}));
 return {
  meta:async()=>{},
  connect(...args){
   const pair=ready().then(transport=>transport.connect(...args));
   pair.catch(e=>{try{args[6](e);}catch{}});
   return [async data=>(await pair)[0](data),async(code,reason)=>(await pair)[1](code,reason)];
  },
 };
}
