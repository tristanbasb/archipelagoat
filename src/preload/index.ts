import { contextBridge } from 'electron'

// Minimal bridge. Task 2 replaces it with the typed `window.goat` API (invoke, on, os, pathForFile).
// Built as a single CJS file: a sandboxed preload may only require('electron').
contextBridge.exposeInMainWorld('goat', { os: process.platform })
