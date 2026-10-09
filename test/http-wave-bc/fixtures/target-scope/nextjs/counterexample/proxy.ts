import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (!request.headers.get('x-token')) return new NextResponse('unauthorized', { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: '/api/secure/:path*' };
