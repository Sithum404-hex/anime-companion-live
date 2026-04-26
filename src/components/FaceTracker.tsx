import { useEffect, useRef } from 'react'
import type { FaceData } from '../types'

interface Props {
  onFaceData: (data: FaceData | null) => void
}

export function FaceTracker({ onFaceData }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const rafRef = useRef<number>(0)
  const faceLandmarkerRef = useRef<unknown>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')

        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        )

        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU',
          },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 1,
        })

        if (cancelled) return
        faceLandmarkerRef.current = faceLandmarker

        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const video = videoRef.current!
        video.srcObject = stream
        video.play()

        let lastTime = -1
        const loop = () => {
          if (cancelled) return
          if (video.currentTime !== lastTime) {
            lastTime = video.currentTime
            const result = (faceLandmarker as { detectForVideo: (v: HTMLVideoElement, t: number) => { faceBlendshapes?: Array<{ categories: Array<{ categoryName: string; score: number }> }> } }).detectForVideo(video, performance.now())
            if (result.faceBlendshapes?.length) {
              const shapes = result.faceBlendshapes[0].categories
              const get = (name: string) => shapes.find(c => c.categoryName === name)?.score ?? 0
              onFaceData({
                mouthOpen: get('jawOpen'),
                eyeOpenLeft: 1 - get('eyeBlinkLeft'),
                eyeOpenRight: 1 - get('eyeBlinkRight'),
                browUpLeft: get('browInnerUp'),
                browUpRight: get('browInnerUp'),
                headRotX: 0,
                headRotY: 0,
                headRotZ: 0,
              })
            }
          }
          rafRef.current = requestAnimationFrame(loop)
        }
        rafRef.current = requestAnimationFrame(loop)
      } catch (e) {
        console.warn('Face tracking unavailable:', e)
        onFaceData(null)
      }
    }

    init()
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      onFaceData(null)
    }
  }, [onFaceData])

  return (
    <video
      ref={videoRef}
      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      playsInline
      muted
    />
  )
}
