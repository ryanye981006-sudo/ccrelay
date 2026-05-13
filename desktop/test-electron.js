const { app, BrowserWindow } = require('electron');
console.log('app:', typeof app);
console.log('whenReady:', typeof app?.whenReady);
app.whenReady().then(() => {
  console.log('Electron ready!');
  app.quit();
});
