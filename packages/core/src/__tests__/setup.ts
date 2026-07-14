import { Window } from 'happy-dom';

const storageWindow = new Window({ url: 'http://localhost/' });

Object.defineProperty(globalThis, 'Storage', {
  value: storageWindow.Storage,
  configurable: true,
});

Object.defineProperty(globalThis, 'StorageEvent', {
  value: storageWindow.StorageEvent,
  configurable: true,
});

Object.defineProperty(globalThis, 'localStorage', {
  value: storageWindow.localStorage,
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: storageWindow.sessionStorage,
  configurable: true,
});
