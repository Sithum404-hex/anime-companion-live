
# Add a visible chat message log

The OpenRouter integration already works (`aiEngine.ts` → `chatWithAI`), but replies only flash briefly as a speech bubble. I'll add a proper, persistent chat panel so you can see the full conversation while typing.

## What changes

### 1. New `ChatPanel.tsx` (replaces the transient bubble)
A scrollable chat log pinned above the input bar showing the full back-and-forth:
- User messages aligned right (primary color bubble)
- Assistant messages aligned left (card bubble)
- "Thinking…" indicator while waiting for AI
- Auto-scrolls to newest message
- Empty state: "Say hi to your waifu 👋"
- Markdown rendering of assistant replies (via `react-markdown`)

### 2. `src/routes/index.tsx` — wire it in
- Remove the `bubble` state and the speech-bubble `<motion.div>`
- Render `<ChatPanel messages={history} busy={busy} />` above the `<ChatBar>`
- Keep voice/animation calls (`handleRef.current?.speak`, `triggerHappy`) intact but untouched — chat works independently
- Surface API errors as both a toast AND a system message in the log so failures are visible

### 3. `src/waifu/aiEngine.ts` — minor robustness
- Trim trailing/leading whitespace from replies
- Clearer error messages for 401 (bad key), 402 (out of credits), 429 (rate limit)
- No model change (keeps free Llama 3.2)

### 4. `src/waifu/ChatBar.tsx` — small fix
- `Enter` to send, `Shift+Enter` for newline (currently fine via form submit, just confirming)
- Clear input only after successful send so user doesn't lose text on failure

### 5. Dependency
- Add `react-markdown` for rendering assistant responses

## Flow (unchanged from current code, just made visible)
```
user types → ChatBar.onSend → handleSend in index.tsx
  → append {role:"user"} to history
  → chatWithAI(apiKey, history)  ← OpenRouter POST
  → append {role:"assistant", content: reply} to history
  → ChatPanel re-renders with new message
```

## What I'm NOT touching (per your request)
- VRM rendering, lip sync, animation, TTS, mic, webcam, motion detection — all left as-is
- Settings panel — already has the API key field

## Result
A real chat window where you type, see your message, see the AI's reply persisted in a scrollable log, and can continue the conversation. Voice and animation continue to fire in the background but are not the focus.
