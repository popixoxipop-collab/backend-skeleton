export async function requireAuth(ctx, next) {
  if (!ctx.get('x-token')) {
    ctx.status = 401;
    return;
  }
  await next();
}
