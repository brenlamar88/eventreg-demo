/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a native Node client; keep it external to the server bundle (Next 14).
  experimental: {
    serverComponentsExternalPackages: ['pg'],
  },
};

export default nextConfig;
