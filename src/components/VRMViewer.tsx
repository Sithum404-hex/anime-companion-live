import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRM, VRMUtils, VRMExpressionPresetName } from '@pixiv/three-vrm'
import './VRMViewer.css'

interface Props {
  modelUrl: string | null
  onReady: () => void
  emotion: 'idle' | 'happy' | 'surprised' | 'sad'
  isTalking: boolean
}

export interface VRMViewerHandle {
  setExpression: (name: string, weight: number) => void
  lookAt: (x: number, y: number) => void
}

const DEFAULT_VRM_URL = 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm'

export const VRMViewer = forwardRef<VRMViewerHandle, Props>(function VRMViewer(
  { modelUrl, onReady, emotion, isTalking },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const vrmRef = useRef<VRM | null>(null)
  const clockRef = useRef(new THREE.Clock())
  const blinkTimerRef = useRef(0)
  const idleTimerRef = useRef(0)
  const talkPhaseRef = useRef(0)

  useImperativeHandle(ref, () => ({
    setExpression(name: string, weight: number) {
      if (!vrmRef.current) return
      const expr = vrmRef.current.expressionManager
      if (expr) {
        try { expr.setValue(name as VRMExpressionPresetName, weight) } catch { /* unsupported expression */ }
      }
    },
    lookAt(_x: number, _y: number) {
      // lookAt is handled by the animation loop
    },
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20)
    camera.position.set(0, 1.3, 2.8)
    camera.lookAt(0, 1.2, 0)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))

    const dirLight = new THREE.DirectionalLight(0xffeef8, 1.2)
    dirLight.position.set(1, 2, 2)
    scene.add(dirLight)

    const rimLight = new THREE.DirectionalLight(0x00d4ff, 0.4)
    rimLight.position.set(-2, 1, -1)
    scene.add(rimLight)

    const pinkFill = new THREE.PointLight(0xff6b9d, 0.8, 5)
    pinkFill.position.set(-1, 2, 1)
    scene.add(pinkFill)

    const loader = new GLTFLoader()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loader.register((parser: any) => new VRMLoaderPlugin(parser))

    loader.load(
      modelUrl || DEFAULT_VRM_URL,
      (gltf: GLTF) => {
        const vrm = gltf.userData['vrm'] as VRM
        if (!vrm) return
        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.combineSkeletons(gltf.scene)
        vrm.scene.rotation.y = Math.PI
        scene.add(vrm.scene)
        vrmRef.current = vrm
        onReady()
      },
      undefined,
      (err) => console.warn('VRM load error:', err)
    )

    let rafId: number
    const animate = () => {
      rafId = requestAnimationFrame(animate)
      const delta = clockRef.current.getDelta()
      const elapsed = clockRef.current.elapsedTime

      if (vrmRef.current) {
        const vrm = vrmRef.current
        const expr = vrm.expressionManager

        if (expr) {
          idleTimerRef.current += delta
          const breathe = Math.sin(idleTimerRef.current * 0.8) * 0.015
          vrm.scene.position.y = breathe

          blinkTimerRef.current += delta
          if (blinkTimerRef.current > 3.5 + Math.random() * 2) {
            blinkTimerRef.current = 0
            const blinkAnim = (t: number) => {
              const v = t < 0.5 ? t * 2 : 2 - t * 2
              try { expr.setValue(VRMExpressionPresetName.Blink, v) } catch { /* skip */ }
              if (t < 1) setTimeout(() => blinkAnim(t + 0.1), 16)
            }
            blinkAnim(0)
          }

          if (isTalking) {
            talkPhaseRef.current += delta * 14
            const jaw = Math.abs(Math.sin(talkPhaseRef.current)) * 0.6
            try { expr.setValue(VRMExpressionPresetName.Aa, jaw) } catch { /* skip */ }
          } else {
            try { expr.setValue(VRMExpressionPresetName.Aa, 0) } catch { /* skip */ }
          }
        }

        vrm.scene.rotation.y = Math.PI + Math.sin(elapsed * 0.3) * 0.04
        vrm.update(delta)
      }

      renderer.render(scene, camera)
    }
    animate()

    const handleResize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', handleResize)
      renderer.dispose()
      if (vrmRef.current) {
        VRMUtils.deepDispose(vrmRef.current.scene)
        vrmRef.current = null
      }
    }
  }, [modelUrl])

  useEffect(() => {
    const vrm = vrmRef.current
    if (!vrm?.expressionManager) return
    const expr = vrm.expressionManager
    const map: Partial<Record<string, VRMExpressionPresetName>> = {
      happy: VRMExpressionPresetName.Happy,
      surprised: VRMExpressionPresetName.Surprised,
      sad: VRMExpressionPresetName.Sad,
    }
    Object.values(VRMExpressionPresetName).forEach((v) => {
      try { expr.setValue(v, 0) } catch { /* skip */ }
    })
    const target = map[emotion]
    if (target) {
      try { expr.setValue(target, 0.85) } catch { /* skip */ }
    }
  }, [emotion])

  return (
    <div className="vrm-viewer">
      <canvas ref={canvasRef} className="vrm-canvas" />
      <div className="vrm-floor" />
    </div>
  )
})
