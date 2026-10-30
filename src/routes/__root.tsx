import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AI Anime Waifu" },
      {
        name: "description",
        content: "An interactive 3D anime character that talks, listens, and reacts.",
      },
      { name: "author", content: "AI Anime Waifu" },
      { property: "og:title", content: "AI Anime Waifu" },
      {
        property: "og:description",
        content: "An interactive 3D anime character that talks, listens, and reacts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@AnimeWaifu" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;600&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { mode, loading } = useAuth();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = router.state.location.pathname;

  useEffect(() => {
    if (loading) return;
    const hasGuestFlag = localStorage.getItem("waifu.auth.v1") !== null;
    const isAuthed = mode === "authenticated";

    // First-time visitor — no session, no guest flag — go to /auth
    if (!isAuthed && !hasGuestFlag && pathname !== "/auth") {
      navigate({ to: "/auth", replace: true });
    }
  }, [mode, loading, pathname, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070912]">
        <div className="flex items-center gap-3 text-white/45">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#F08CA0]" aria-hidden />
          <p className="font-serif text-sm">Opening the door…</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate>
        <Outlet />
      </AuthGate>
    </AuthProvider>
  );
}
