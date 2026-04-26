import { useCallback, useState } from 'react'
import type { ChatMessage } from '../types'

declare global {
  interface Window {
    puter?: {
      ai?: {
        chat: (prompt: string, options?: Record<string, unknown>) => Promise<string | { message?: { content?: string } }>
      }
    }
  }
}

const SYSTEM_PROMPT = `You are Yuki-chan, an enthusiastic and cute AI VTuber companion who lives in the browser. You are cheerful, playful, and slightly kawaii. You express emotions clearly in your replies and keep them short and lively (1-3 sentences max). You occasionally use Japanese words like "sugoi!", "kawaii", "nani?!", "ara ara", etc., but primarily speak English. You react emotionally to what people say and always try to make them smile. When happy, start with something upbeat. When surprised, react with wonder. When sad topics come up, be gentle and comforting.

At the END of every reply, append one of these emotion tags (just the tag, no extra text after it):
[EMOTION:happy], [EMOTION:surprised], [EMOTION:sad], [EMOTION:idle]

Pick the most fitting emotion for what you just said.`

const FALLBACK_REPLIES = [
  "Konnichiwa! I'm Yuki-chan, your browser companion! Puter AI isn't available right now, but I'm still here~ [EMOTION:happy]",
  "Ara ara, my AI brain seems sleepy right now, but don't worry, I'm still watching over you! [EMOTION:idle]",
  "Sugoi, you talked to me! I'd love to reply properly once my AI wakes up~ [EMOTION:surprised]",
]

interface Props {
  onEmotionChange: (e: 'idle' | 'happy' | 'surprised' | 'sad') => void
}

export function useAIChat({ onEmotionChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isThinking, setIsThinking] = useState(false)

  const sendMessage = useCallback(async (text: string): Promise<string | null> => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    setIsThinking(true)

    let reply = ''
    try {
      if (window.puter?.ai?.chat) {
        const history = messages.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'Yuki'}: ${m.content}`).join('\n')
        const prompt = `${SYSTEM_PROMPT}\n\nConversation so far:\n${history}\n\nUser: ${text}\nYuki:`
        const result = await window.puter.ai.chat(prompt)
        if (typeof result === 'string') {
          reply = result
        } else if (typeof result === 'object' && result?.message?.content) {
          reply = result.message.content
        } else {
          reply = FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]
        }
      } else {
        await new Promise(r => setTimeout(r, 800))
        reply = FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]
      }
    } catch {
      reply = FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]
    }

    // Extract and strip emotion tag
    const emotionMatch = reply.match(/\[EMOTION:(\w+)\]/)
    if (emotionMatch) {
      const e = emotionMatch[1] as 'idle' | 'happy' | 'surprised' | 'sad'
      onEmotionChange(e)
      reply = reply.replace(/\[EMOTION:\w+\]/, '').trim()
    } else {
      onEmotionChange('idle')
    }

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, assistantMsg])
    setIsThinking(false)
    return reply
  }, [messages, onEmotionChange])

  return { messages, sendMessage, isThinking }
}
