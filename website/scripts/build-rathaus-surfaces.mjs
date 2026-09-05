// Compatibility entry point for the checked-in Rathaus sample.
process.argv.splice(2, 0, 'muenchner-rathaus-100m');
await import('./build-area-surfaces.mjs');
