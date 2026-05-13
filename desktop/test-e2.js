const e = require('electron');
console.log('typeof:', typeof e);
console.log('is string:', typeof e === 'string');
console.log('keys:', typeof e === 'object' ? Object.keys(e).slice(0,5) : 'N/A');
console.log('value (if string):', typeof e === 'string' ? e : 'N/A');
console.log('app:', e.app);
process.exit(0);
