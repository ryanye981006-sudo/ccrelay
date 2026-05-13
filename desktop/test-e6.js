// Check if we can at least start Electron properly by looking at behavior
console.log('Node version:', process.version);
console.log('Electron version:', process.versions.electron);
console.log('Chrome version:', process.versions.chrome);
console.log('Process features:', Object.keys(process.features || {}));
console.log('process.resourcesPath:', process.resourcesPath);
// Try to see if the issue is that this runs as a utility process
console.log('argv:', process.argv.slice(0, 5));
process.exit(0);
