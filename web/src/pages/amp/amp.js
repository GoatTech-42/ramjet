import '../../lib/cloak.js';
import { mount } from 'svelte';
import Amp from './Amp.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Amp, { target: document.getElementById('app') });
