import { useEffect } from 'react'
import type { VRMViewerHandle } from '../components/VRMViewer'
import type { FaceData } from '../types'

interface Props {
  vrmRef: React.RefObject<VRMViewerHandle | null>
  isTalking: boolean
  emotion: 'idle' | 'happy' | 'surprised' | 'sad'
  faceData: FaceData | null
}

export function useVRMController({ vrmRef, faceData }: Props) {
  useEffect(() => {
    if (!faceData || !vrmRef.current) return
    const vrm = vrmRef.current
    vrm.setExpression('mouthOpen', faceData.mouthOpen)
    vrm.setExpression('blinkLeft', 1 - faceData.eyeOpenLeft)
    vrm.setExpression('blinkRight', 1 - faceData.eyeOpenRight)
    if (faceData.headRotY !== undefined) {
      vrm.lookAt(faceData.headRotY * 30, -faceData.headRotX * 30)
    }
  }, [faceData, vrmRef])
}
