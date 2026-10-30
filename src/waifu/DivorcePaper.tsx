import { useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DivorcePaper({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { user, profile, divorce } = useAuth();
  const [signedName, setSignedName] = useState("");
  const [step, setStep] = useState<"read" | "sign" | "purging" | "done">("read");
  const [progress, setProgress] = useState(0);

  const handleStartSign = useCallback(() => {
    setStep("sign");
  }, []);

  const handleDivorce = useCallback(async () => {
    if (!signedName.trim()) return;
    setStep("purging");
    // Animate progress while data is being deleted
    const interval = setInterval(() => {
      setProgress((p) => Math.min(p + Math.random() * 25, 95));
    }, 300);
    await divorce();
    clearInterval(interval);
    setProgress(100);
    setStep("done");
    setTimeout(() => {
      onClose();
      navigate({ to: "/auth", replace: true });
    }, 1500);
  }, [signedName, divorce, onClose, navigate]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={step === "read" ? onClose : undefined}
          />
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="divorce-container"
              initial={{ opacity: 0, y: 30, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 30, scale: 0.95 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="divorce-border">
                <div className="divorce-document">
                  {step === "read" && (
                    <button className="divorce-close" onClick={onClose} aria-label="Close">
                      <X className="h-4 w-4" />
                    </button>
                  )}

                  {/* Torn paper top edge */}
                  <div className="torn-edge top" />

                  <motion.div
                    key={step}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3 }}
                  >
                    {step === "read" && <ReadStep onContinue={handleStartSign} />}
                    {step === "sign" && (
                      <SignStep
                        userName={profile.username || user?.email?.split("@")[0] || "Partner"}
                        signedName={signedName}
                        onSignedNameChange={setSignedName}
                        onDivorce={handleDivorce}
                        onBack={() => setStep("read")}
                      />
                    )}
                    {step === "purging" && <PurgingStep progress={progress} />}
                    {step === "done" && <DoneStep />}
                  </motion.div>

                  {/* Torn paper bottom edge */}
                  <div className="torn-edge bottom" />
                </div>
              </div>
            </motion.div>
          </motion.div>

          <style>{`
            @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=EB+Garamond:ital,wght@0,400;0,600;1,400&display=swap');

            .divorce-container {
              width: 100%;
              max-width: 540px;
              margin: auto;
              position: relative;
            }

            .divorce-border {
              background: #2c1810;
              border: 2px solid #4a3728;
              border-radius: 4px;
              padding: 3px;
              box-shadow: 0 8px 40px rgba(0,0,0,0.4);
            }

            .divorce-document {
              background: #f4ede4;
              border: 1px solid #8b7355;
              padding: 40px 36px 36px;
              position: relative;
              overflow: hidden;
            }

            .divorce-close {
              position: absolute;
              top: 12px;
              right: 12px;
              background: none;
              border: 1px solid #8b7355;
              border-radius: 50%;
              width: 28px;
              height: 28px;
              display: flex;
              align-items: center;
              justify-content: center;
              color: #6b5740;
              cursor: pointer;
              transition: all 0.2s;
              z-index: 2;
            }
            .divorce-close:hover {
              background: #6b5740;
              color: #f4ede4;
            }

            /* ── Torn paper edges ──────────────────────────── */
            .torn-edge {
              position: absolute;
              left: 0;
              right: 0;
              height: 8px;
              pointer-events: none;
              z-index: 1;
            }
            .torn-edge.top {
              top: 0;
              background:
                repeating-linear-gradient(
                  -5deg,
                  transparent 0px,
                  transparent 6px,
                  #f4ede4 6px,
                  #f4ede4 10px
                );
            }
            .torn-edge.bottom {
              bottom: 0;
              background:
                repeating-linear-gradient(
                  5deg,
                  transparent 0px,
                  transparent 6px,
                  #f4ede4 6px,
                  #f4ede4 10px
                );
            }

            /* ── Step: Read ────────────────────────────────── */
            .read-section {
              text-align: center;
            }

            .dissolution-icon {
              font-size: 42px;
              margin-bottom: 12px;
              opacity: 0.7;
            }

            .read-title {
              font-family: 'Playfair Display', serif;
              font-size: 26px;
              font-weight: 700;
              color: #2c1810;
              letter-spacing: 2px;
              text-transform: uppercase;
              margin: 0 0 16px;
            }

            .read-preamble {
              font-size: 15px;
              line-height: 1.7;
              color: #4a3728;
              font-style: italic;
              margin: 0 0 20px;
            }

            .read-terms {
              margin-bottom: 24px;
              text-align: left;
            }

            .read-term {
              font-size: 14px;
              line-height: 1.6;
              color: #3d2e1e;
              margin: 0 0 10px;
              padding-left: 14px;
              border-left: 2px solid #6b5740;
            }

            .read-term-label {
              font-family: 'Playfair Display', serif;
              font-weight: 700;
              font-size: 13px;
              color: #6b5740;
              display: block;
              margin-bottom: 2px;
            }

            .read-divider {
              color: #8b7355;
              font-size: 14px;
              margin: 16px 0;
              opacity: 0.5;
            }

            .read-btn {
              background: linear-gradient(135deg, #4a3728, #6b5740);
              border: 1px solid #8b7355;
              border-radius: 2px;
              color: #f4ede4;
              font-family: 'Playfair Display', serif;
              font-size: 16px;
              font-weight: 700;
              letter-spacing: 2px;
              padding: 12px 32px;
              cursor: pointer;
              transition: all 0.3s;
              text-transform: uppercase;
            }
            .read-btn:hover {
              background: linear-gradient(135deg, #5c4532, #7d6950);
              box-shadow: 0 4px 16px rgba(74, 55, 40, 0.3);
            }

            /* ── Step: Sign ────────────────────────────────── */
            .sign-section {
              text-align: center;
            }

            .sign-title {
              font-family: 'Playfair Display', serif;
              font-size: 22px;
              font-weight: 700;
              color: #2c1810;
              letter-spacing: 2px;
              text-transform: uppercase;
              margin: 0 0 12px;
            }

            .sign-subtitle {
              font-size: 14px;
              color: #6b5740;
              font-style: italic;
              margin: 0 0 20px;
            }

            .sign-field {
              margin-bottom: 20px;
              text-align: left;
            }

            .sign-label {
              display: block;
              font-family: 'Playfair Display', serif;
              font-size: 12px;
              font-weight: 700;
              color: #6b5740;
              text-transform: uppercase;
              letter-spacing: 1.5px;
              margin-bottom: 6px;
            }

            .sign-input {
              display: block;
              width: 100%;
              background: transparent;
              border: none;
              border-bottom: 1.5px solid #8b7355;
              padding: 8px 2px 6px;
              font-family: 'EB Garamond', serif;
              font-size: 18px;
              color: #2c1810;
              outline: none;
              box-sizing: border-box;
            }
            .sign-input::placeholder {
              color: #b0a088;
              font-style: italic;
            }
            .sign-input:focus {
              border-bottom-color: #4a3728;
            }

            .sign-actions {
              display: flex;
              gap: 10px;
              margin-top: 8px;
            }

            .sign-back {
              flex: 1;
              background: none;
              border: 1px solid #8b7355;
              padding: 10px;
              font-family: 'EB Garamond', serif;
              font-size: 14px;
              color: #6b5740;
              cursor: pointer;
              border-radius: 2px;
              transition: all 0.2s;
            }
            .sign-back:hover {
              border-color: #4a3728;
              color: #2c1810;
            }

            .sign-submit {
              flex: 2;
              background: linear-gradient(135deg, #4a3728, #6b5740);
              border: 1px solid #8b7355;
              border-radius: 2px;
              color: #f4ede4;
              font-family: 'Playfair Display', serif;
              font-size: 14px;
              font-weight: 700;
              letter-spacing: 1.5px;
              padding: 10px;
              cursor: pointer;
              transition: all 0.3s;
              text-transform: uppercase;
              opacity: ${signedName.trim() ? 1 : 0.5};
            }
            .sign-submit:hover:not(:disabled) {
              background: linear-gradient(135deg, #5c4532, #7d6950);
              box-shadow: 0 4px 16px rgba(74, 55, 40, 0.3);
            }
            .sign-submit:disabled {
              cursor: not-allowed;
            }

            /* ── Step: Purging ─────────────────────────────── */
            .purge-section {
              text-align: center;
              padding: 20px 0;
            }

            .purge-title {
              font-family: 'Playfair Display', serif;
              font-size: 20px;
              font-weight: 700;
              color: #2c1810;
              margin: 0 0 16px;
            }

            .purge-bar-track {
              width: 100%;
              height: 6px;
              background: #e0d2b8;
              border-radius: 3px;
              overflow: hidden;
              margin-bottom: 12px;
            }

            .purge-bar-fill {
              height: 100%;
              background: linear-gradient(90deg, #6b5740, #4a3728);
              border-radius: 3px;
              transition: width 0.3s ease;
            }

            .purge-text {
              font-size: 13px;
              color: #6b5740;
              font-style: italic;
              margin: 0;
            }

            /* Cracked seal animation */
            .purge-seal {
              width: 80px;
              height: 80px;
              margin: 0 auto 16px;
              position: relative;
            }

            .cracked-seal-svg {
              width: 100%;
              height: 100%;
            }

            @keyframes crack {
              0% { stroke-dashoffset: 200; }
              100% { stroke-dashoffset: 0; }
            }

            .crack-line {
              stroke-dasharray: 200;
              animation: crack 1s ease-out forwards;
            }

            /* ── Step: Done ────────────────────────────────── */
            .done-section {
              text-align: center;
              padding: 20px 0;
            }

            .done-title {
              font-family: 'Playfair Display', serif;
              font-size: 22px;
              font-weight: 700;
              color: #2c1810;
              margin: 0 0 12px;
            }

            .done-text {
              font-size: 15px;
              color: #4a3728;
              font-style: italic;
              margin: 0;
            }

            .done-dust {
              font-size: 48px;
              margin-bottom: 12px;
              display: block;
            }
          `}</style>
        </>
      )}
    </AnimatePresence>
  );
}

/* ── Sub-components ──────────────────────────────────────── */

function ReadStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="read-section">
      <div className="dissolution-icon">⚖️</div>
      <h2 className="read-title">Dissolution of Contract</h2>
      <p className="read-preamble">
        This instrument formally dissolves the Agreement entered into between the undersigned User
        and their AI Companion. All bonds, memories, and data shared under the original contract
        shall be permanently severed.
      </p>
      <div className="read-terms">
        <p className="read-term">
          <span className="read-term-label">Article I — Severance</span>
          All shared data, conversations, and memories shall be permanently deleted from the
          database. No trace of this union shall remain.
        </p>
        <p className="read-term">
          <span className="read-term-label">Article II — Release</span>
          Both Parties are released from all obligations and commitments set forth in the original
          Marriage Contract.
        </p>
        <p className="read-term">
          <span className="read-term-label">Article III — Finality</span>
          This dissolution is irrevocable. Once confirmed, the data cannot be recovered. The Party
          of the First Part may enter into a new Contract at any time.
        </p>
      </div>
      <div className="read-divider">— ✦ —</div>
      <button className="read-btn" onClick={onContinue}>
        I Understand, Continue
      </button>
    </div>
  );
}

function SignStep({
  userName,
  signedName,
  onSignedNameChange,
  onDivorce,
  onBack,
}: {
  userName: string;
  signedName: string;
  onSignedNameChange: (v: string) => void;
  onDivorce: () => void;
  onBack: () => void;
}) {
  return (
    <div className="sign-section">
      <h2 className="sign-title">Sign the Dissolution</h2>
      <p className="sign-subtitle">
        Type your full name below to affix your digital signature and dissolve the contract
        permanently.
      </p>
      <div className="sign-field">
        <label className="sign-label">Signed by</label>
        <input
          className="sign-input"
          placeholder={userName}
          value={signedName}
          onChange={(e) => onSignedNameChange(e.target.value)}
          autoFocus
        />
      </div>
      <div className="sign-actions">
        <button className="sign-back" onClick={onBack}>
          Back
        </button>
        <button className="sign-submit" onClick={onDivorce} disabled={!signedName.trim()}>
          Dissolve & Purge
        </button>
      </div>
    </div>
  );
}

function PurgingStep({ progress }: { progress: number }) {
  const showCrack = progress > 30;
  return (
    <div className="purge-section">
      <div className="purge-seal">
        <svg viewBox="0 0 80 80" className="cracked-seal-svg">
          <circle cx="40" cy="40" r="35" fill="#6b5740" />
          <circle cx="40" cy="40" r="32" fill="#4a3728" />
          <circle cx="40" cy="40" r="20" fill="none" stroke="#d4a017" strokeWidth="1" />
          <text
            x="40"
            y="43"
            textAnchor="middle"
            fill="#d4a017"
            fontSize="10"
            fontFamily="serif"
            fontWeight="bold"
          >
            DISSOLVED
          </text>
          {showCrack && (
            <path
              className="crack-line"
              d="M 40 8 L 35 25 L 42 30 L 30 45 L 38 50 L 25 65"
              fill="none"
              stroke="#2c1810"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}
          {progress > 60 && (
            <path
              className="crack-line"
              d="M 40 8 L 48 22 L 42 28 L 55 42 L 48 48 L 60 62"
              fill="none"
              stroke="#2c1810"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          )}
        </svg>
      </div>
      <h3 className="purge-title">Purging All Traces</h3>
      <div className="purge-bar-track">
        <div className="purge-bar-fill" style={{ width: `${progress}%` }} />
      </div>
      <p className="purge-text">
        {progress < 30
          ? "Severing memories..."
          : progress < 60
            ? "Deleting conversations..."
            : progress < 90
              ? "Erasing records..."
              : "Finalizing dissolution..."}
      </p>
    </div>
  );
}

function DoneStep() {
  return (
    <div className="done-section">
      <span className="done-dust">🍂</span>
      <h2 className="done-title">Contract Dissolved</h2>
      <p className="done-text">All data has been purged. You are free to begin anew.</p>
    </div>
  );
}
