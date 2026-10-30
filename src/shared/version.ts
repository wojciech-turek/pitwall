declare const __APP_VERSION__: string

/** The app version, injected from package.json at build time (unpackaged Electron's app.getVersion() is Electron's own). */
export const APP_VERSION: string = __APP_VERSION__
