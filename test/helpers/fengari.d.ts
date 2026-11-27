// The Lua engine the Redis stand-in runs scripts in. It ships no types; the stand-in uses a small part of it.
declare module "fengari" {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(text: string): Uint8Array;
  export function to_jsstring(bytes: Uint8Array): string;
}
