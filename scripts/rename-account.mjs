import { DATA_ROOT } from '../core/data.js';
import { planIdentity, applyIdentity, requireStopped, serverIdentityLock } from '../core/identity-migration.js';
const [command,oldName,newName]=process.argv.slice(2);
try {
  requireStopped(DATA_ROOT);
  if(command==='recover'){serverIdentityLock(DATA_ROOT);console.log('Identity recovery checked.');}
  else if(command==='plan'||command==='apply'){
    // Do not change role/exception policy as a side effect of identity migration.
    const protectedNames=[process.env.RJ_ADMIN||'admin',process.env.RJ_SYNC_ADMIN||'admin','admin','admin','administrator','root','ramjet','support','system'];
    if(!oldName||!newName)throw new Error('supply old and new usernames');
    const plan=planIdentity(DATA_ROOT,oldName,newName,{protectedNames});
    if(command==='plan')console.log(JSON.stringify({files:plan.changes.map(c=>c.path),count:plan.changes.length}));
    else console.log(JSON.stringify(applyIdentity(DATA_ROOT,plan)));
  }else throw new Error('use plan OLD NEW, apply OLD NEW, or recover');
}catch{console.error('Identity migration stopped. Check account names, protected identities, server lock, store integrity and unfinished journal. No secrets or store contents are printed.');process.exitCode=1;}
