import { useRef, useState, useCallback } from 'react'
import { VRMViewer } from './components/VRMViewer'
import { ChatPanel } from './components/ChatPanel'
import { StatusBar } from './components/StatusBar'
import { FaceTracker } from './components/FaceTracker'
import { useAIChat } from './hooks/useAIChat'
import { useSpeech } from './hooks/useSpeech'
import { useVRMController } from './hooks/useVRMController'
import type { FaceData } from './types'
import './App.css'

export default function App() {
  const vrmRef = useRef<{ setExpression: (name: string, weight: number) => void; lookAt: (x: number, y: number) => void } | null>(null)
  const [faceData, setFaceData] = useState<FaceData | null>(null)
  const [emotion, setEmotion] = useState<'idle' | 'happy' | 'surprised' | 'sad'>('idle')
  const [vrmReady, setVrmReady] = useState(false)
  const [faceTrackingEnabled, setFaceTrackingEnabled] = useState(false)
  const [modelUrl, setModelUrl] = useState<string | null>(null)

  const { messages, sendMessage, isThinking } = useAIChat({ onEmotionChange: setEmotion })
  const { speak, stopSpeaking, isSpeaking, voices, selectedVoice, setSelectedVoice, isListening, startListening, stopListening } = useSpeech()

  useVRMController({ vrmRef, isTalking: isSpeaking, emotion, faceData: faceTrackingEnabled ? faceData : null })

  const handleSend = useCallback(async (text: string) => {
    const reply = await sendMessage(text)
    if (reply) {
      speak(reply)
    }
  }, [sendMessage, speak])

  const handleVoiceInput = useCallback(() => {
    if (isListening) {
      stopListening()
    } else {
      startListening((transcript) => {
        handleSend(transcript)
      })
    }
  }, [isListening, startListening, stopListening, handleSend])

  return (
    <div className="app">
      <div className="scene-container">
        <VRMViewer
          ref={vrmRef}
          modelUrl={modelUrl}
          onReady={() => setVrmReady(true)}
          emotion={emotion}
          isTalking={isSpeaking}
        />
        <div className="scene-overlay">
          <div className="vignette" />
          <div className="scanlines" />
        </div>
      </div>

      {faceTrackingEnabled && (
        <FaceTracker onFaceData={setFaceData} />
      )}

      <StatusBar
        vrmReady={vrmReady}
        isTalking={isSpeaking}
        isThinking={isThinking}
        isListening={isListening}
        faceTrackingEnabled={faceTrackingEnabled}
        onToggleFaceTracking={() => setFaceTrackingEnabled(v => !v)}
        onStopSpeaking={stopSpeaking}
        voices={voices}
        selectedVoice={selectedVoice}
        onVoiceChange={setSelectedVoice}
        onModelLoad={setModelUrl}
      />

      <ChatPanel
        messages={messages}
        onSend={handleSend}
        onVoiceInput={handleVoiceInput}
        isListening={isListening}
        isThinking={isThinking}
        isSpeaking={isSpeaking}
      />
    </div>
  )
}
