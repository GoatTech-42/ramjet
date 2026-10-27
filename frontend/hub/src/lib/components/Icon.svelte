<script>
  import { paths } from '../icons.js'
  let { name, size = 20 } = $props()
  const d = $derived(paths[name] ?? '')
</script>
<svg class="ic" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path {d}/></svg>
