import '../../lib/cloak.js';
import { mount } from 'svelte';
import Banter from './Banter.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Banter, { target: document.getElementById('app') });
