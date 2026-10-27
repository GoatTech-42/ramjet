import { mount } from 'svelte'
import './lib/tokens.css'
import './lib/motion.css'
import './lib/shell.css'
import './lib/cloak.js'
import App from './App.svelte'
mount(App, { target: document.getElementById('app') })
