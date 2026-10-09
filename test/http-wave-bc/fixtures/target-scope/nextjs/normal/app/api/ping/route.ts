async function handler() {
  return Response.json({ pong: true });
}

export { handler as GET, handler as POST };
