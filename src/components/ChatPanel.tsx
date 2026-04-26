import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../types'
import './ChatPanel.css'

interface Props {
  messages: ChatMessage[]
  onSend: (text: string) => void
  onVoiceInput: () => void
  isListening: boolean
  isThinking: boolean
  isSpeaking: boolean
}

export function ChatPanel({ messages, onSend, onVoiceInput, isListening, isThinking, isSpeaking }: Props) {
  const [input, setInput] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    setInput('')
    onSend(text)
  }

  return (
    <div className={`chat-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="chat-header" onClick={() => setCollapsed(v => !v)}>
        <div className="chat-header-left">
          <div className="avatar-dot" />
          <span className="chat-title">Yuki-chan</span>
          {isSpeaking && <span className="speaking-badge">speaking</span>}
          {isThinking && <span className="thinking-badge">thinking...</span>}
        </div>
        <button className="collapse-btn" aria-label="toggle chat">
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>Say hello to Yuki-chan!</p>
                <p className="chat-empty-hint">Type a message or press the mic button to speak</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="msg-avatar">Y</div>
                )}
                <div className="msg-bubble">
                  <p>{msg.content}</p>
                </div>
              </div>
            ))}
            {isThinking && (
              <div className="chat-msg chat-msg--assistant">
                <div className="msg-avatar">Y</div>
                <div className="msg-bubble thinking-bubble">
                  <span className="dot" /><span className="dot" /><span className="dot" />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form className="chat-input-row" onSubmit={handleSubmit}>
            <button
              type="button"
              className={`mic-btn ${isListening ? 'mic-btn--active' : ''}`}
              onClick={onVoiceInput}
              title={isListening ? 'Stop listening' : 'Start voice input'}
            >
              {isListening ? '■' : '🎤'}
            </button>
            <input
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={isListening ? 'Listening...' : 'Say something to Yuki...'}
              disabled={isListening}
            />
            <button className="send-btn" type="submit" disabled={!input.trim() || isThinking}>
              ➤
            </button>
          </form>
        </>
      )}
    </div>
  )
}
