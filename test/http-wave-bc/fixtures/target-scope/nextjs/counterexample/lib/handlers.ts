export function createHandlers(name: string) {
  return {
    GET: async () => Response.json({ list: name }),
    POST: async () => Response.json({ created: name }, { status: 201 }),
  };
}
