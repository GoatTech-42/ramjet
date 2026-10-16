import '../../lib/cloak.js';
import { mount } from 'svelte';
import Hub from './Hub.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Hub, { target: document.getElementById('app') });
