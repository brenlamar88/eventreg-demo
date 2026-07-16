import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// When auth is enabled, refresh the session on every request and require a
// signed-in user for everything except /login, API routes, and static assets.
// Otherwise this middleware is a pass-through (open mode).
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const authOn = process.env.NEXT_PUBLIC_AUTH_ENABLED === 'true';
  const path = request.nextUrl.pathname;
  // API routes (e.g. /api/health, webhooks) do their own auth and must stay
  // reachable even when locked out — never gate them behind the login redirect.
  const isApi = path.startsWith('/api');
  // Open mode (default) or missing keys: no auth gate. Login is only enforced
  // when explicitly enabled, so the Supabase integration setting these keys does
  // not lock out a site that has no users yet.
  if (!authOn || !url || !anon || isApi) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLogin = request.nextUrl.pathname.startsWith('/login');
  if (!user && !isLogin) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    return NextResponse.redirect(redirectUrl);
  }
  if (user && isLogin) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/';
    return NextResponse.redirect(redirectUrl);
  }
  return response;
}

export const config = {
  // everything except Next internals and static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
