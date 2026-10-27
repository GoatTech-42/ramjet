// Test-build-only integration. No DOM selectors or production code dependencies.
// Parent shell must remain in the same document throughout the measured task.
export function createM10Hooks(probe, {clock=()=>performance.now()}={}) {
  if (!probe || typeof probe.invoke!=='function' || typeof probe.usable!=='function') throw Error('M10 probe required');
  let sequence=0, active=null;
  const audit=[];
  const requireActive=id=>{
    if (!active || active.id!==id || active.cancelled || active.usable) throw Error('stale, cancelled or completed browse operation');
    return active;
  };
  const record=(name,id)=>audit.push({name,id,t:clock()});
  return Object.freeze({
    invoke(event) {
      if (!event?.isTrusted || !['click','keydown','submit'].includes(event.type)) throw Error('trusted invoke event required');
      if (active && !active.usable && !active.cancelled) throw Error('overlapping operation: cancel previous task explicitly');
      const id=++sequence;
      // Keep a single gated invocation in each page measurement, not first/last cherry-picking.
      if (sequence>1) throw Error('one invocation per measured page; reload for a new observation');
      probe.invoke();active={id,rendered:false,inputVerified:false,usable:false,cancelled:false};record('invoke',id);return id;
    },
    primaryContentRendered(id, {responseSucceeded, isErrorPage, overlayBlocksInput}) {
      const a=requireActive(id);
      if (responseSucceeded!==true || isErrorPage!==false || overlayBlocksInput!==false) throw Error('successful primary content without blocking overlay required');
      a.rendered=true;record('primary-content-rendered',id);
    },
    inputVerified(id, {inputOccurred, observedEffect, kind}) {
      const a=requireActive(id);
      if (!a.rendered) throw Error('verify input after rendering current response');
      if (inputOccurred!==true || observedEffect!==true || !['scroll','type','navigate'].includes(kind)) throw Error('real input with visible task-relevant effect required');
      a.inputVerified=true;record('input-verified',id);
    },
    usable(id) {
      const a=requireActive(id);
      if (!a.rendered || !a.inputVerified) throw Error('primary content AND input acceptance are required');
      // Audited usable time is after verification. This is conservative: do not backdate it.
      probe.usable({contentRendered:true,acceptsInput:true});a.usable=true;record('usable',id);
    },
    cancel(id) {const a=requireActive(id);a.cancelled=true;record('cancel',id);},
    evidence() {return {active:active?{...active}:null,audit:audit.map(x=>({...x})),status:'ASSERTIONS_REQUIRE_INTEGRATION_AND_VISUAL_REVIEW'};}
  });
}
