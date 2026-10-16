import '../../lib/cloak.js';
import { mount } from 'svelte';
import Login from './Login.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Login, { target: document.getElementById('app') });
