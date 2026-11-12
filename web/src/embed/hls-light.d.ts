// hls.js ships the light build without its own type declarations; it has the same API.
declare module 'hls.js/light' {
  export * from 'hls.js';
  export { default } from 'hls.js';
}
