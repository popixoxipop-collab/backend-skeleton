type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(_request: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return Response.json({ path });
}
