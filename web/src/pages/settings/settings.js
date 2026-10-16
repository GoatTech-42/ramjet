import '../../lib/cloak.js';
import { mount } from 'svelte';
import Settings from './Settings.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Settings, { target: document.getElementById('app') });
