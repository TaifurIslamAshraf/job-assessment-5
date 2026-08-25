import { NextRequest } from "next/server";

/**
 * Forwards /api/* to the backend from the server side.
 *
 * The browser only ever talks to this app's own origin, so there is no CORS and
 * no API URL compiled into the client bundle. `API_ORIGIN` is read per request,
 * which means the backend can move without rebuilding the frontend — the thing
 * a NEXT_PUBLIC_ variable cannot do, because Next inlines those at build time.
 */
export const dynamic = "force-dynamic";

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const origin = process.env.API_ORIGIN ?? "http://localhost:3001";
  const { path } = await ctx.params;
  const target = `${origin}/api/${path.join("/")}${req.nextUrl.search}`;

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.text();

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // A dead backend would otherwise surface as an opaque 500 from Next.
    return Response.json(
      {
        message: `Cannot reach the API at ${origin}: ${(error as Error).message}`,
      },
      { status: 502 },
    );
  }
}

export { proxy as GET, proxy as POST };
