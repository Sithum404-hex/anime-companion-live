# Security

## Secrets

- Server keys belong in `.env.local` (gitignored) or the deployment environment. Never commit them.
- Only `VITE_*` values reach the browser. Treat every `VITE_*` value as public; never put an API key there.
- `npm run check:secrets` scans the working tree for common key formats. CI runs it on every push and pull request.
- `npm run build` runs `scripts/check-build-secrets.mjs` after the build. If a real key from `.env.local` appears in `dist/client` or `dist/server`, the build fails.
- For Cloudflare, `npm run secrets:cloudflare` pushes `OPENROUTER_API_KEY`, `TYPECAST_API_KEY`, and `GEMINI_API_KEY` from `.env.local` into Worker secrets via stdin. It never prints the values. Authenticate first with `npx wrangler login` or `CLOUDFLARE_API_TOKEN`.

## If a key leaks

1. Revoke and rotate it in the provider dashboard first. Assume any key that reached a public repo is compromised.
2. Remove it from the working tree and from `.env.local`.
3. If it was committed, purge it from history with `git filter-repo` (or BFG) and force-push.
4. Tell collaborators to re-clone, because their local clones still contain the old history.
5. A force-push removes the branch reference but GitHub can keep serving unreachable commits by SHA. After rotating the key, ask GitHub Support to purge cached views, or delete and recreate the repository if it has no valuable history.

## Auth and offline mode

Supabase is optional. When `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, the app runs in guest mode and keeps settings/history in `localStorage`; it must never fail at import time.
