import { useRef, useState } from 'react'
import './StatusBar.css'

interface Props {
  vrmReady: boolean
  isTalking: boolean
  isThinking: boolean
  isListening: boolean
  faceTrackingEnabled: boolean
  onToggleFaceTracking: () => void
  onStopSpeaking: () => void
  voices: SpeechSynthesisVoice[]
  selectedVoice: SpeechSynthesisVoice | null
  onVoiceChange: (v: SpeechSynthesisVoice) => void
  onModelLoad: (url: string) => void
}

export function StatusBar({
  vrmReady, isTalking, isThinking, isListening,
  faceTrackingEnabled, onToggleFaceTracking, onStopSpeaking,
  voices, selectedVoice, onVoiceChange, onModelLoad,
}: Props) {
  const [showSettings, setShowSettings] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    onModelLoad(url)
    setShowSettings(false)
  }

  const handleUrlLoad = () => {
    if (urlInput.trim()) {
      onModelLoad(urlInput.trim())
      setUrlInput('')
      setShowSettings(false)
    }
  }

  return (
    <>
      <div className="status-bar">
        <div className="status-left">
          <div className="name-tag">
            <span className="name-tag-label">YUKI-CHAN</span>
            <div className="name-tag-deco" />
          </div>
          <div className="status-indicators">
            <span className={`indicator ${vrmReady ? 'indicator--on' : 'indicator--loading'}`}>
              {vrmReady ? 'LIVE' : 'LOADING'}
            </span>
            {isListening && <span className="indicator indicator--listen">MIC</span>}
            {isThinking && <span className="indicator indicator--think">AI</span>}
            {isTalking && (
              <button className="indicator indicator--talk indicator--btn" onClick={onStopSpeaking}>
                SPEAKING ✕
              </button>
            )}
          </div>
        </div>
        <div className="status-right">
          <button
            className={`icon-btn ${faceTrackingEnabled ? 'icon-btn--active' : ''}`}
            onClick={onToggleFaceTracking}
            title={faceTrackingEnabled ? 'Disable face tracking' : 'Enable face tracking'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4"/>
              <path d="M8 14s-4 2-4 6h16c0-4-4-6-4-6"/>
              <circle cx="9" cy="7" r="1" fill="currentColor"/>
              <circle cx="15" cy="7" r="1" fill="currentColor"/>
            </svg>
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(v => !v)}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <div className="settings-header">
            <h3>Settings</h3>
            <button className="settings-close" onClick={() => setShowSettings(false)}>✕</button>
          </div>

          <div className="settings-section">
            <label className="settings-label">VRM Model</label>
            <div className="settings-row">
              <button className="settings-btn" onClick={() => fileRef.current?.click()}>
                Load from file
              </button>
              <input type="file" ref={fileRef} accept=".vrm" onChange={handleFileLoad} style={{ display: 'none' }} />
            </div>
            <div className="settings-row url-row">
              <input
                className="settings-input"
                placeholder="VRM URL..."
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleUrlLoad()}
              />
              <button className="settings-btn settings-btn--pink" onClick={handleUrlLoad}>Load</button>
            </div>
          </div>

          {voices.length > 0 && (
            <div className="settings-section">
              <label className="settings-label">Voice</label>
              <select
                className="settings-select"
                value={selectedVoice?.name || ''}
                onChange={e => {
                  const v = voices.find(v => v.name === e.target.value)
                  if (v) onVoiceChange(v)
                }}
              >
                {voices.map(v => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </div>
          )}

          <div className="settings-section">
            <label className="settings-label">Face Tracking</label>
            <button
              className={`settings-btn ${faceTrackingEnabled ? 'settings-btn--pink' : ''}`}
              onClick={onToggleFaceTracking}
            >
              {faceTrackingEnabled ? 'Enabled (click to disable)' : 'Disabled (click to enable)'}
            </button>
            {faceTrackingEnabled && (
              <p className="settings-note">Camera permission required. Your face controls Yuki's expressions in real-time.</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
