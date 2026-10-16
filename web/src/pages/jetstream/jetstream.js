import '../../lib/cloak.js';
import { mount } from 'svelte';
import Jetstream from './Jetstream.svelte';
import { installPreloadRecovery } from '../../lib/preload-recover.js';
installPreloadRecovery();
mount(Jetstream, { target: document.getElementById('app') });
