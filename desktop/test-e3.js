console.log('electron version:', process.versions.electron);
console.log('chrome version:', process.versions.chrome);
console.log('process.type:', process.type);
console.log('electron require test...');
const e = require('electron');
console.log('typeof require(electron):', typeof e);
console.log('keys if obj:', typeof e === 'object' ? Object.keys(e).slice(0, 10) : 'N/A');
