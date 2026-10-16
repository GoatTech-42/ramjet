import '../../lib/cloak.js';
import { mount } from 'svelte';
import Claim from './Claim.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Claim, { target: document.getElementById('app') });
