export interface FaceData {
  mouthOpen: number
  eyeOpenLeft: number
  eyeOpenRight: number
  browUpLeft: number
  browUpRight: number
  headRotX: number
  headRotY: number
  headRotZ: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}
