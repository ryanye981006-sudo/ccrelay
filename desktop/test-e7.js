const e = require('electron');
console.log('typeof require(electron):', typeof e);
if (typeof e === 'object') {
  console.log('app:', typeof e.app);
  console.log('IT WORKS!');
} else {
  console.log('STILL BROKEN:', typeof e === 'string' ? e.substring(0,80) : e);
}
process.exit(0);
