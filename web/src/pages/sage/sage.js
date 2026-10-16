import '../../lib/cloak.js';
import { mount } from 'svelte';
import Sage from './Sage.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Sage, { target: document.getElementById('app') });
