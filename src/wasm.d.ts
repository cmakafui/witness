// Bun gives a file import its URL. This tells the type checker so.
declare module "@relate/relate-wasm/relate_bg.wasm" {
  const url: string;
  export default url;
}
