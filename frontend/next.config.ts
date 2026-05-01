import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
      // Shim broken @wagmi/core@3.x tempo internal import
      "accounts": false,
      // Shim missing MetaMask SDK peer dep in @wagmi/connectors@8.x
      "@metamask/connect-evm": false,
    };
    return config;
  },
};

export default nextConfig;