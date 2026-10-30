# Deploy Guide — Hosting Your Anime Waifu on Cloudflare

## How Cloudflare Hosting Works (Simple Explanation)

**Your laptop does NOT need to stay on. Ever.**

Cloudflare Pages + Workers is a "serverless" hosting service. That means:

- Your website files live on **Cloudflare's servers** (350+ data centers worldwide)
- Users connect to Cloudflare, not your laptop
- It works **24/7** whether your computer is on, asleep, or broken
- It's the **same concept as Netlify or Vercel**

Think of it like uploading a video to YouTube vs streaming it from your phone. YouTube stores the video on their servers — your phone can go offline and the video still plays. Same idea here: Cloudflare stores your website, your laptop can be off.

---

## How Updates Work

You don't manually upload files. Instead:

1. You **push code to GitHub** (like saving a new version)
2. GitHub **notifies Cloudflare** automatically
3. Cloudflare **builds + deploys** the new version (takes ~1-2 minutes)
4. Your website updates **automatically**

Every `git push` = instant update. No FTP, no file uploads, no laptop required.

---

## Step-by-Step Setup

### Step 1: Push your code to GitHub

If you haven't already:

```bash
# Create a new repo on GitHub.com first (don't add README or .gitignore)
# Then run these commands in your project folder:

git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

### Step 2: Go to Cloudflare Dashboard

1. Go to https://dash.cloudflare.com/
2. Sign up or log in (free tier is enough)
3. Click **"Workers & Pages"** in the left menu
4. Click **"Create"** → **"Pages"** → **"Connect to Git"**

### Step 3: Connect GitHub

1. Authorize Cloudflare to access your GitHub (first time only)
2. Select the repo you pushed in Step 1
3. Under **"Set up builds and deployments"**:

| Setting                      | Value           |
| ---------------------------- | --------------- |
| Build command                | `npm run build` |
| Build output directory       | `dist`          |
| Root directory (leave blank) |                 |
| Node.js version              | `22`            |

4. Click **"Save and Deploy"**

### Step 4: Set API Keys (Secrets)

Your app needs API keys for TTS (voice), AI chat, and Gemini Live (realtime
voice + camera conversation). These are stored securely as "secrets" — not in
your code. A template with every variable name is in `.env.example` at the
repo root.

1. In Cloudflare dashboard, go to **"Workers & Pages"**
2. Click your project name
3. Go to the **"Settings"** tab → **"Environment variables"**
4. Add these **"Secret"** variables (click "Add variable" → choose "Secret"):

| Variable name        | Value                              | Needed for               |
| -------------------- | ---------------------------------- | ------------------------ |
| `TYPECAST_API_KEY`   | (copy from your `.env.local` file) | Voice output (all modes) |
| `OPENROUTER_API_KEY` | (copy from your `.env.local` file) | Chat + Screen Vision     |
| `GEMINI_API_KEY`     | (copy from your `.env.local` file) | **Live mode only**       |

> **Live mode will not work without `GEMINI_API_KEY`.** It is used only on the
> server, by the `createLiveToken` server function, to mint short-lived
> ephemeral tokens for the Gemini Live WebSocket - no permanent key ever reaches
> the browser. If it is missing, the Live panel shows
> "GEMINI_API_KEY not set on server." while Chat and Screen modes keep working.

### Live mode: `GEMINI_API_KEY` in detail

- **Variable name:** `GEMINI_API_KEY` (exactly this — no `VITE_` prefix).
- **Where to configure it:**
  - Local development: add it to `.env.local` at the repo root (see
    `.env.example`).
  - Production: add it as a **Secret** environment variable in the Cloudflare
    dashboard (Settings → Environment variables), same as the other keys above.
- **Server-side only:** it is read exclusively inside the `createLiveToken`
  server function (`src/lib/liveToken.ts`) via `process.env.GEMINI_API_KEY`.
- **Never exposed to the browser:** do NOT rename it to `VITE_GEMINI_API_KEY`
  and do not reference it from any client-side code. Anything prefixed
  `VITE_` is bundled into the public JavaScript sent to every visitor.
- **Architecture:** Live mode uses the existing ephemeral-token architecture —
  the browser never sees your API key. The client calls the `createLiveToken`
  server function, receives a short-lived token (≈30 min, single session), and
  connects directly to the Gemini Live WebSocket with that token. Your
  long-lived `GEMINI_API_KEY` stays on the server at all times.

Make sure you use the non-VITE versions (e.g. TYPECAST_API_KEY, not VITE_TYPECAST_API_KEY).

#### CLI alternative (recommended)

After `npx wrangler login`, push all three server keys from `.env.local` without
copying them into the dashboard:

```bash
npm run secrets:cloudflare
```

The script sends each value through stdin, so it never appears in the command
line or shell history. Preview what it will upload with:

```bash
npm run secrets:cloudflare -- --dry-run
```

Never put these keys in `wrangler.jsonc`, `VITE_*` variables, or any file that
is committed. The build runs a post-build scan and fails if a real key is
inlined into the client bundle.

5. Click **"Save"**

### Step 5: Wait for first deploy

Cloudflare will build and deploy automatically. Once done, you'll get a URL like:
`https://YOUR_PROJECT_NAME.pages.dev`

That's your live website. Visit it from any device.

---

## How to Push Updates (After Setup)

Every time you make changes and want them live:

```bash
# 1. Add your changes
git add .
git commit -m "describe what you changed"

# 2. Push to GitHub
git push
```

That's it. Cloudflare detects the push, builds, and deploys automatically. Wait ~1-2 minutes and your changes are live.

### What NOT to do

- Do NOT touch the `dist/` folder (it's auto-generated)
- Do NOT manually upload files to Cloudflare
- Do NOT edit files on Cloudflare's dashboard
- Just `git push` — always

---

## Manual Deploy (Alternative)

If you don't want auto-deploy on every push, you can deploy manually from your computer:

```bash
# One-time login
npx wrangler login

# Build + deploy whenever you want
npm run build
npx wrangler deploy
```

You still don't need your laptop to stay on after deploy — it's only needed when you want to push an update.

---

## Common Questions

**Q: Do I need a credit card for Cloudflare?**\
A: The free tier is enough to host this app. No credit card required to start.

**Q: Does my laptop need to be on?**\
A: No. Once deployed, your laptop can be turned off, asleep, or thrown away — the website stays live on Cloudflare's servers.

**Q: Is this like Netlify/Vercel?**\
A: Yes. Same concept. Cloudflare Pages + Workers works identically to Netlify or Vercel. Some would argue it's better because Cloudflare has 350+ data centers (Netlify/Vercel have fewer).

**Q: How long does an update take?**\
A: ~1-2 minutes after `git push`. Cloudflare builds the project and deploys automatically.

**Q: My website updated but I still see the old version?**\
A: Your browser might have cached the old files. Open an incognito/private tab or hard refresh (Ctrl+F5).

**Q: Can I use a custom domain (like waifu.mysite.com)?**\
A: Yes. In Cloudflare dashboard → your project → Settings → Custom domains. You need to own the domain.

**Q: What about the database (Supabase)?**\
A: Supabase is already a cloud service — it stays running independently. Nothing to change.

---

## Troubleshooting

| Problem          | Fix                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build fails      | Check Cloudflare dashboard → your project → Deployments tab → click failed deploy → see build log for the error                                                                                                                  |
| API calls fail   | Make sure you set the secrets (Step 4). Check browser console (F12) for errors.                                                                                                                                                  |
| TTS not working  | In Cloudflare dashboard → your project → Settings → Environment variables → verify TYPECAST_API_KEY is set as a Secret                                                                                                           |
| Live not working | In Cloudflare dashboard → your project → Settings → Environment variables → verify GEMINI_API_KEY is set as a Secret (Step 4). It is used only server-side; the Live panel shows "GEMINI_API_KEY not set on server." if missing. |
| Blank white page | The build might have failed. Check the deployment log.                                                                                                                                                                           |
