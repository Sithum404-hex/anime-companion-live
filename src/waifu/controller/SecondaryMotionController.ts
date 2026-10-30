import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMSpringBoneJoint } from "@pixiv/three-vrm-springbone";
import type { VRMSpringBoneJointSettings } from "@pixiv/three-vrm-springbone";
import type { AnimState } from "./AnimationStateMachine";
import { PHYSICS_CONFIG } from "../physicsConfig";
import { BoneClassifier, type BoneCategory } from "../physics/BoneClassifier";

type SecondaryKind = "hair" | "tail" | "ear" | "bust";

interface SpringSnapshot {
  hitRadius: number;
  stiffness: number;
  gravityPower: number;
  gravityDir: THREE.Vector3;
  dragForce: number;
}

interface TunedSpring {
  joint: VRMSpringBoneJoint;
  kind: SecondaryKind;
  original: SpringSnapshot;
  tuned: SpringSnapshot;
  phase: number;
  side: number;
}

interface AudioMotionFrame {
  intensity: number;
  bass: number;
  beat: boolean;
}

const DOWN = new THREE.Vector3(0, -1, 0);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function snapshot(settings: VRMSpringBoneJointSettings): SpringSnapshot {
  return {
    hitRadius: settings.hitRadius,
    stiffness: settings.stiffness,
    gravityPower: settings.gravityPower,
    gravityDir: settings.gravityDir.clone(),
    dragForce: settings.dragForce,
  };
}

function restore(settings: VRMSpringBoneJointSettings, snap: SpringSnapshot): void {
  settings.hitRadius = snap.hitRadius;
  settings.stiffness = snap.stiffness;
  settings.gravityPower = snap.gravityPower;
  settings.dragForce = snap.dragForce;
  settings.gravityDir.copy(snap.gravityDir);
}

function classifyJoint(name: string): SecondaryKind | null {
  const lower = name.toLowerCase();
  if (lower.includes("foxtail") || lower.includes("tail") || lower.includes("shippo")) {
    return "tail";
  }
  if (lower.includes("catear") || lower.includes("ear")) {
    return "ear";
  }
  if (lower.includes("hair") || lower.includes("bang") || lower.includes("pony")) {
    return "hair";
  }
  return null;
}

function sideFromName(name: string): number {
  if (/(^|_)l(_|$)/i.test(name) || /left/i.test(name)) return -1;
  if (/(^|_)r(_|$)/i.test(name) || /right/i.test(name)) return 1;
  return 0;
}

function tunedSnapshot(kind: SecondaryKind, original: SpringSnapshot): SpringSnapshot {
  const tuned = {
    ...original,
    gravityDir:
      original.gravityDir.clone().lengthSq() > 0 ? original.gravityDir.clone() : DOWN.clone(),
  };

  const cfg = PHYSICS_CONFIG[kind === "ear" ? "ears" : kind];
  const clamps = PHYSICS_CONFIG.nativeClamps[kind === "ear" ? "ears" : kind];

  if (kind === "tail") {
    tuned.stiffness = clamp(cfg.stiffness, clamps.stiffness[0], clamps.stiffness[1]);
    tuned.dragForce = clamp(cfg.dragForce, clamps.dragForce[0], clamps.dragForce[1]);
    tuned.gravityPower = Math.max(cfg.gravityPower, clamps.gravityMin);
    tuned.hitRadius = cfg.hitRadius;
    return tuned;
  }

  if (kind === "ear") {
    tuned.stiffness = clamp(cfg.stiffness, clamps.stiffness[0], clamps.stiffness[1]);
    tuned.dragForce = clamp(
      cfg.dragForce + PHYSICS_CONFIG.nativeClamps.ears.dragOffset,
      clamps.dragForce[0],
      clamps.dragForce[1],
    );
    tuned.gravityPower = Math.max(cfg.gravityPower, clamps.gravityMin);
    tuned.hitRadius = cfg.hitRadius;
    return tuned;
  }

  if (kind === "bust") {
    tuned.stiffness = clamp(cfg.stiffness, clamps.stiffness[0], clamps.stiffness[1]);
    tuned.dragForce = clamp(cfg.dragForce, clamps.dragForce[0], clamps.dragForce[1]);
    tuned.gravityPower = Math.max(cfg.gravityPower, clamps.gravityMin);
    tuned.hitRadius = cfg.hitRadius;
    return tuned;
  }

  tuned.stiffness = clamp(cfg.stiffness, clamps.stiffness[0], clamps.stiffness[1]);
  tuned.dragForce = clamp(cfg.dragForce, clamps.dragForce[0], clamps.dragForce[1]);
  tuned.gravityPower = Math.max(cfg.gravityPower, clamps.gravityMin);
  tuned.hitRadius = cfg.hitRadius;
  return tuned;
}

export class SecondaryMotionController {
  private springs: TunedSpring[] = [];
  private t = 0;
  private beatImpulse = 0;
  private gravityDir = new THREE.Vector3();

  constructor(private vrm: VRM) {
    this.initialize();
  }

  get activeSpringCount(): number {
    return this.springs.length;
  }

  private initialize(): void {
    const manager = this.vrm.springBoneManager;
    if (!manager) return;

    // Step 1: discover existing native spring bone joints
    const joints = Array.from(manager.joints);
    joints.forEach((joint, index) => {
      const kind = classifyJoint(joint.bone.name);
      if (!kind) return;

      const original = snapshot(joint.settings);
      const tuned = tunedSnapshot(kind, original);
      restore(joint.settings, tuned);

      this.springs.push({
        joint,
        kind,
        original,
        tuned,
        phase: index * 0.73 + Math.random() * Math.PI * 2,
        side: sideFromName(joint.bone.name),
      });
    });

    // Step 2: register missing spring joints from skeleton bones
    const missingKinds: { kind: SecondaryKind; category: BoneCategory }[] = [
      { kind: "hair", category: "hair" },
      { kind: "tail", category: "tail" },
      { kind: "ear", category: "ear" },
    ];
    for (const { kind, category } of missingKinds) {
      if (!this.springs.some((s) => s.kind === kind)) {
        this.registerMissingJoints(manager, kind, category);
      }
    }

    // Step 3: register bust/chest spring joint from humanoid bones
    if (!this.springs.some((s) => s.kind === "bust")) {
      this.registerBustJoint(manager);
    }

    manager.reset();
  }

  private registerBustJoint(manager: { addJoint(joint: VRMSpringBoneJoint): void }): void {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;

    const chest = humanoid.getNormalizedBoneNode("chest");
    const upperChest = humanoid.getNormalizedBoneNode("upperChest");
    const target = upperChest || chest;
    if (!target) return;

    // Find the first child for the spring bone tail
    let child: THREE.Object3D | null = null;
    for (const c of target.children) {
      if (c instanceof THREE.Bone) {
        child = c;
        break;
      }
    }

    const cfg = PHYSICS_CONFIG.bust;
    const jointSettings: Partial<VRMSpringBoneJointSettings> = {
      stiffness: cfg.stiffness,
      gravityPower: cfg.gravityPower,
      gravityDir: cfg.gravityDir.clone(),
      dragForce: cfg.dragForce,
      hitRadius: cfg.hitRadius,
    };

    const joint = new VRMSpringBoneJoint(target, child, jointSettings);
    manager.addJoint(joint);

    const original = snapshot(joint.settings);
    const tuned = tunedSnapshot("bust", original);
    restore(joint.settings, tuned);

    this.springs.push({
      joint,
      kind: "bust",
      original,
      tuned,
      phase: Math.random() * Math.PI * 2,
      side: 0,
    });
  }

  private registerMissingJoints(
    manager: { addJoint(joint: VRMSpringBoneJoint): void },
    kind: SecondaryKind,
    category: BoneCategory,
  ): void {
    const classifier = new BoneClassifier(this.vrm);
    const chains = classifier.getChainsByCategory(category);
    if (chains.length === 0) return;

    const configKey = kind === "ear" ? "ears" : kind;
    const cfg = PHYSICS_CONFIG[configKey];
    const jointSettings: Partial<VRMSpringBoneJointSettings> = {
      stiffness: cfg.stiffness,
      gravityPower: cfg.gravityPower,
      gravityDir: cfg.gravityDir.clone(),
      dragForce: cfg.dragForce,
      hitRadius: cfg.hitRadius,
    };

    for (const chain of chains) {
      for (let i = 0; i < chain.length; i++) {
        const cb = chain[i];
        const child = i + 1 < chain.length ? chain[i + 1].bone : null;

        const joint = new VRMSpringBoneJoint(cb.bone, child, jointSettings);
        manager.addJoint(joint);

        const original = snapshot(joint.settings);
        const tuned = tunedSnapshot(kind, original);
        restore(joint.settings, tuned);

        this.springs.push({
          joint,
          kind,
          original,
          tuned,
          phase: i * 0.73 + Math.random() * Math.PI * 2,
          side: cb.side,
        });
      }
    }
  }

  update(dt: number, animState: AnimState, audio: AudioMotionFrame): void {
    if (this.springs.length === 0) return;

    dt = Math.min(dt, 0.033);
    this.t += dt;

    if (audio.beat) {
      this.beatImpulse = Math.min(1, this.beatImpulse + 0.55);
    } else {
      this.beatImpulse = Math.max(0, this.beatImpulse - dt * 2.6);
    }

    const stateMotion =
      animState === "dance"
        ? 0.95
        : animState === "happy" || animState === "gesture" || animState === "surprised"
          ? 0.42
          : animState === "talking"
            ? 0.26
            : 0.12;

    const musicMotion = clamp(audio.intensity * 0.85 + audio.bass * 0.7, 0, 1.1);
    const activity = clamp(stateMotion + musicMotion + this.beatImpulse * 0.35, 0, 1.45);

    for (const item of this.springs) {
      const settings = item.joint.settings;
      const base = item.tuned;
      const side = item.side !== 0 ? item.side : Math.sin(item.phase) > 0 ? 1 : -1;

      if (item.kind === "tail") {
        const sway = Math.sin(this.t * 2.0 + item.phase) * (0.13 + activity * 0.22);
        const bounce = Math.sin(this.t * 3.7 + item.phase * 0.5) * activity * 0.06;
        this.gravityDir.set(sway, -1, bounce + this.beatImpulse * 0.08).normalize();
        settings.stiffness = clamp(base.stiffness * (1 - activity * 0.16), 0.18, 0.9);
        settings.dragForce = clamp(base.dragForce - activity * 0.06, 0.12, 0.48);
        settings.gravityPower = clamp(base.gravityPower + activity * 0.035, 0.02, 0.13);
      } else if (item.kind === "ear") {
        const twitch =
          Math.sin(this.t * 5.0 + item.phase) * 0.025 + this.beatImpulse * 0.035 * side;
        this.gravityDir.set(twitch, -1, 0.015 * activity).normalize();
        settings.stiffness = clamp(base.stiffness * (1 + this.beatImpulse * 0.05), 0.75, 1.7);
        settings.dragForce = clamp(base.dragForce - activity * 0.015, 0.05, 0.24);
        settings.gravityPower = clamp(base.gravityPower + activity * 0.006, 0.004, 0.025);
      } else if (item.kind === "bust") {
        const sway = Math.sin(this.t * 1.7 + item.phase) * (0.015 + activity * 0.03);
        const bounce = Math.sin(this.t * 2.5 + item.phase * 0.8) * activity * 0.015;
        this.gravityDir.set(sway, -1, bounce).normalize();
        settings.stiffness = clamp(base.stiffness * (1 - activity * 0.08), 0.24, 0.78);
        settings.dragForce = clamp(base.dragForce - activity * 0.025, 0.2, 0.72);
        settings.gravityPower = clamp(base.gravityPower + activity * 0.012, 0.008, 0.04);
      } else {
        const sway = Math.sin(this.t * 1.35 + item.phase) * (0.035 + activity * 0.075);
        const flutter = Math.sin(this.t * 2.8 + item.phase * 1.7) * activity * 0.025;
        this.gravityDir
          .set(sway + flutter * side, -1, Math.cos(this.t * 1.1 + item.phase) * activity * 0.035)
          .normalize();
        settings.stiffness = clamp(base.stiffness * (1 - activity * 0.12), 0.14, 1.2);
        settings.dragForce = clamp(base.dragForce - activity * 0.045, 0.1, 0.42);
        settings.gravityPower = clamp(base.gravityPower + activity * 0.018, 0.01, 0.08);
      }

      settings.gravityDir.copy(this.gravityDir);
    }
  }

  dispose(): void {
    for (const item of this.springs) {
      restore(item.joint.settings, item.original);
    }
    this.vrm.springBoneManager?.reset();
    this.springs = [];
  }
}
