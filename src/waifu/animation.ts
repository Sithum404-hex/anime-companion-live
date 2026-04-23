import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import type { WaifuState, Emotion } from "./types";

export class AnimationController {
  vrm: VRM;
  private t = 0;
  private blinkTimer = 0;
  private nextBlink = 2;
  private state: WaifuState = "IDLE";
  private emotion: Emotion = "calm";
  private lookTarget = new THREE.Vector2(0, 0); // -1..1
  private lookSmoothed = new THREE.Vector2(0, 0);
  private headOffset = new THREE.Euler(0, 0, 0);
  private armBlend = 0;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  setState(s: WaifuState) {
    this.state = s;
  }
  setEmotion(e: Emotion) {
    this.emotion = e;
  }
  setLook(x: number, y: number) {
    this.lookTarget.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  }

  update(dt: number) {
    this.t += dt;
    const vrm = this.vrm;
    const hum = vrm.humanoid;
    if (!hum) return;

    // breathing
    const breath = Math.sin(this.t * 1.4) * 0.02;
    const chest = hum.getNormalizedBoneNode(VRMHumanBoneName.Chest) || hum.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
    if (chest) chest.rotation.x = breath * 0.5;
    const spine = hum.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    if (spine) spine.rotation.x = breath * 0.3;

    // head sway
    this.lookSmoothed.lerp(this.lookTarget, Math.min(1, dt * 4));
    const head = hum.getNormalizedBoneNode(VRMHumanBoneName.Head);
    const neck = hum.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const sway = Math.sin(this.t * 0.6) * 0.04;
    const targetYaw = this.lookSmoothed.x * 0.4 + sway;
    const targetPitch = -this.lookSmoothed.y * 0.25 + Math.sin(this.t * 0.8) * 0.02;
    this.headOffset.y = THREE.MathUtils.lerp(this.headOffset.y, targetYaw, Math.min(1, dt * 5));
    this.headOffset.x = THREE.MathUtils.lerp(this.headOffset.x, targetPitch, Math.min(1, dt * 5));
    if (head) {
      head.rotation.y = this.headOffset.y * 0.6;
      head.rotation.x = this.headOffset.x * 0.6;
    }
    if (neck) {
      neck.rotation.y = this.headOffset.y * 0.4;
      neck.rotation.x = this.headOffset.x * 0.4;
    }

    // arms idle pose — bring arms down from T-pose to natural rest at sides.
    // For VRM, upper-arm rotation.z rotates around the forward axis:
    //   Left arm needs negative Z to drop down, Right arm needs positive Z.
    // "happy" raises them outward/up.
    const targetArm = this.state === "HAPPY" ? 1 : this.state === "SCARED" ? 0.4 : 0;
    this.armBlend = THREE.MathUtils.lerp(this.armBlend, targetArm, Math.min(1, dt * 3));
    const setArm = (name: VRMHumanBoneName, restZ: number, happyZ: number, sign: number) => {
      const b = hum.getNormalizedBoneNode(name);
      if (b) {
        const wave = this.state === "HAPPY" ? Math.sin(this.t * 6) * 0.2 * sign : 0;
        b.rotation.z = THREE.MathUtils.lerp(restZ, happyZ + wave, this.armBlend);
        // slight forward shoulder for natural look
        b.rotation.x = THREE.MathUtils.lerp(0.05, -0.3, this.armBlend);
      }
    };
    // Left arm: rest ~ -1.2 rad (down), happy ~ -0.4 (raised outward)
    setArm(VRMHumanBoneName.LeftUpperArm, -1.2, -0.4, -1);
    // Right arm: rest ~ +1.2 rad (down), happy ~ +0.4 (raised outward)
    setArm(VRMHumanBoneName.RightUpperArm, 1.2, 0.4, 1);

    // blinking
    this.blinkTimer += dt;
    const exp = vrm.expressionManager;
    if (exp) {
      if (this.blinkTimer > this.nextBlink) {
        const phase = this.blinkTimer - this.nextBlink;
        const blink = phase < 0.08 ? phase / 0.08 : phase < 0.18 ? 1 - (phase - 0.08) / 0.1 : 0;
        exp.setValue("blink", Math.max(0, Math.min(1, blink)));
        if (phase > 0.2) {
          this.blinkTimer = 0;
          this.nextBlink = 2 + Math.random() * 3;
        }
      } else {
        exp.setValue("blink", 0);
      }

      // emotion expressions
      const happy = this.emotion === "happy" || this.state === "HAPPY" ? 1 : 0;
      const sad = this.emotion === "scared" || this.state === "SCARED" ? 0.7 : 0;
      const surprised = this.state === "SCARED" ? 0.6 : this.emotion === "curious" ? 0.3 : 0;
      const setSmooth = (k: string, v: number) => {
        const cur = exp.getValue(k) ?? 0;
        exp.setValue(k, THREE.MathUtils.lerp(cur, v, Math.min(1, dt * 6)));
      };
      setSmooth("happy", happy);
      setSmooth("sad", sad);
      setSmooth("surprised", surprised);
    }

    vrm.update(dt);
  }
}
