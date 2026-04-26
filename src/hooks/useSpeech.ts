import { useCallback, useEffect, useRef, useState } from 'react'

// SpeechRecognition is not in all TS lib versions, declare locally
interface ISpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onstart: (() => void) | null
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
}

interface ISpeechRecognitionCtor {
  new(): ISpeechRecognition
}

export function useSpeech() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<ISpeechRecognition | null>(null)

  useEffect(() => {
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices()
      if (!all.length) return
      setVoices(all)
      const preferred = all.find(v =>
        v.name.includes('Samantha') ||
        v.name.includes('Karen') ||
        v.name.includes('Google UK English Female') ||
        v.name.includes('Microsoft Zira') ||
        (v.lang.startsWith('en') && v.name.toLowerCase().includes('female'))
      ) || all.find(v => v.lang.startsWith('en')) || all[0]
      setSelectedVoice(preferred)
    }

    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices
    return () => { window.speechSynthesis.onvoiceschanged = null }
  }, [])

  const speak = useCallback((text: string, onDone?: () => void) => {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.voice = selectedVoice
    utterance.rate = 1.05
    utterance.pitch = 1.2
    utterance.volume = 1
    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend = () => { setIsSpeaking(false); onDone?.() }
    utterance.onerror = () => { setIsSpeaking(false); onDone?.() }
    window.speechSynthesis.speak(utterance)
  }, [selectedVoice])

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis.cancel()
    setIsSpeaking(false)
  }, [])

  const startListening = useCallback((onResult: (transcript: string) => void) => {
    const w = window as Window & {
      SpeechRecognition?: ISpeechRecognitionCtor
      webkitSpeechRecognition?: ISpeechRecognitionCtor
    }
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!Ctor) {
      alert('Speech recognition not supported in this browser. Try Chrome!')
      return
    }

    const recognition = new Ctor()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onstart = () => setIsListening(true)
    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = e.results[0][0].transcript
      setIsListening(false)
      onResult(transcript)
    }
    recognition.onerror = () => setIsListening(false)
    recognition.onend = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  return { speak, stopSpeaking, isSpeaking, voices, selectedVoice, setSelectedVoice, isListening, startListening, stopListening }
}
