const e = require('electron');
console.log('typeof require(electron):', typeof e);
console.log('is string:', typeof e === 'string');
if (typeof e === 'string') {
  console.log('path:', e);
  // Workaround: try to access electron internal modules
  // In Electron, built-in modules can be accessed via process._linkedBinding
  // or by using the internal module loader
  console.log('process.type:', process.type);
  console.log('process.versions.electron:', process.versions.electron);
  console.log('Module._resolveFilename exists:', typeof require('module')._resolveFilename);
  
  // Try to find the real electron module
  const Module = require('module');
  const originalResolve = Module._resolveFilename;
  // Override to intercept electron resolution
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'electron') {
      console.log('electron requested, returning internal...');
      // Try various paths to the built-in electron module
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
  
  const e2 = require('electron');
  console.log('e2:', typeof e2);
  process.exit(0);
}
