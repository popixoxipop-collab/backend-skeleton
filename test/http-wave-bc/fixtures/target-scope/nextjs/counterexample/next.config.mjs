// The deployment prefix is a literal followed by an environment-dependent suffix; routes are also mounted by rewrites.
const tenant = process.env.TENANT ?? '';

export default {
  basePath: '/portal' + tenant,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: '/api/:path*' }];
  },
};
