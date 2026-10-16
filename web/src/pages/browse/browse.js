import '../../lib/cloak.js';
import { mount } from 'svelte';
import Browse from './Browse.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Browse, { target: document.getElementById('app') });
