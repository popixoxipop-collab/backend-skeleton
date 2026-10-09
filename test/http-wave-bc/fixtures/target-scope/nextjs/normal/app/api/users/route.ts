export async function GET() {
  return Response.json([{ id: '1' }]);
}

export const POST = async (request: Request) => {
  const body = await request.text();
  return Response.json({ created: body.length }, { status: 201 });
};
