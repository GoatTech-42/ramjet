import '../../lib/cloak.js';
import { mount } from 'svelte';
import Password from './Password.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Password, { target: document.getElementById('app') });
