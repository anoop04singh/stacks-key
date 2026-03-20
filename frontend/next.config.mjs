/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "@noir-lang/acvm_js",
    "@noir-lang/noir_js",
    "@noir-lang/noirc_abi",
    "@noir-lang/noir_wasm",
    "@aztec/bb.js",
  ],
};

export default nextConfig;
