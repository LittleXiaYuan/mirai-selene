import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Mic } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import styles from "./stage.module.css";

const BAR_WEIGHTS = [0.46, 0.82, 1.0, 0.76, 0.42] as const;

/**
 * 5-bar live acoustic waveform rendered inside Arc Button when recording.
 * Bar height breathes continuously with both real mic energy & 12D prosody tension.
 */
function VoiceWaveform({
  energy,
  tension,
  reduce,
}: {
  energy: number;
  tension: number;
  reduce: boolean;
}) {
  const drive = Math.min(1, Math.max(0.22, energy * 0.85 + tension * 0.55));
  return (
    <motion.span
      className={styles.voiceWave}
      aria-hidden
      initial={{ opacity: 0, scale: 0.72 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.72 }}
      transition={reduce ? { duration: 0 } : motionTokens.spring.gentle}
    >
      {BAR_WEIGHTS.map((w, idx) => {
        const peak = Math.min(1, 0.34 + w * drive * 0.92);
        const low = Math.max(0.2, peak * 0.36);
        return (
          <motion.span
            key={idx}
            className={styles.voiceWaveBar}
            animate={
              reduce
                ? { scaleY: peak }
                : {
                    scaleY: [low, peak, low * 1.18, peak * 0.82, low],
                  }
            }
            transition={
              reduce
                ? { duration: 0 }
                : {
                    duration: Math.max(0.42, 0.84 - tension * 0.32),
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: idx * 0.085,
                  }
            }
          />
        );
      })}
    </motion.span>
  );
}

/**
 * 「按住开口」：基于 Arc Button + motionTokens，录音时麦克风丝滑变形为实时声波浪。
 * 波形振幅与外圈光晕实时响应音量（energy）与 12 维副语言张力（tension）。
 */
export function VoiceProsodyButton({
  recording,
  tension,
  energy,
  onStart,
  onStop,
}: {
  recording: boolean;
  tension: number;
  energy: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const reduce = Boolean(useReducedMotion());
  const heat = Math.min(1, tension * 0.8 + energy * 0.3);
  const hot = tension > 0.45;

  return (
    <div className={styles.voice} data-recording={recording ? "" : undefined} data-hot={hot ? "" : undefined}>
      <AnimatePresence>
        {recording ? (
          <motion.span
            className={`${styles.voiceHalo} ${hot ? styles.voiceHaloHot : ""}`}
            aria-hidden
            initial={{ opacity: 0, scale: 0.84 }}
            animate={{ opacity: 0.42 + heat * 0.52, scale: 1 + heat * 0.32 }}
            exit={{ opacity: 0, scale: 0.84 }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    ...motionTokens.spring.gentle,
                    opacity: { duration: motionTokens.duration.standard },
                  }
            }
          />
        ) : null}
      </AnimatePresence>

      <Button
        size="sm"
        variant={recording ? "primary" : "secondary"}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          onStart();
        }}
        onPointerUp={onStop}
        onPointerCancel={onStop}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            onStart();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onStop();
          }
        }}
        aria-label={recording ? "松手结束采集" : "按住开口，把语气带进这一句"}
      >
        <AnimatePresence mode="wait" initial={false}>
          {recording ? (
            <VoiceWaveform key="wave" energy={energy} tension={tension} reduce={reduce} />
          ) : (
            <motion.span
              key="mic"
              className={styles.voiceMic}
              aria-hidden
              initial={{ opacity: 0, scale: 0.72 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.72 }}
              transition={reduce ? { duration: 0 } : motionTokens.spring.gentle}
            >
              <Mic size={14} strokeWidth={1.75} />
            </motion.span>
          )}
        </AnimatePresence>
        <span>{recording ? "正在听" : "按住开口"}</span>
      </Button>
    </div>
  );
}
