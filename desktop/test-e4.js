const e = require('electron');
console.log('typeof:', typeof e);
if (typeof e === 'object') {
  console.log('app:', typeof e.app);
  console.log('BrowserWindow:', typeof e.BrowserWindow);
  e.app.whenReady().then(() => { console.log('READY!'); e.app.quit(); });
} else {
  console.log('STILL STRING:', e);
  process.exit(1);
}
