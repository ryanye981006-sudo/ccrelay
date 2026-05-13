// Try alternative require paths for Electron built-in modules
const paths = ['electron', 'electron/main', 'electron/common', 'electron/browser'];
for (const p of paths) {
  try {
    const m = require(p);
    console.log(p, '→ typeof:', typeof m, typeof m === 'object' ? 'keys:' + Object.keys(m).slice(0,5) : m);
  } catch(e) {
    console.log(p, '→ ERROR:', e.message);
  }
}
process.exit(0);
