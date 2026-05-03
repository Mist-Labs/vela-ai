import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
      "accounts": false,
      "@metamask/connect-evm": false,
    };
    config.module.exprContextCritical = false;
    return config;
  },
};

export default nextConfig;