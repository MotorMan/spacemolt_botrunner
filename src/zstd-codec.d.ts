declare module "zstd-codec" {
  export function compress(data: Uint8Array, level?: number): Uint8Array;
  export function decompress(data: Uint8Array): Uint8Array;
}