import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type MouseEvent,
} from "react";
import "./brand.css";

const BRAND_MOTION_MS = 1800;
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 以完整的单次通电动效呈现品牌；离开不截断，快速重复进入不叠加播放。 */
export function Brand({ onNavigate }: { onNavigate: () => void }) {
  const [running, setRunning] = useState(false);
  const playing = useRef(false);

  /** 统一结束动画，释放播放锁，供下一次悬停或键盘聚焦重播。 */
  const stopMotion = useCallback(() => {
    playing.current = false;
    setRunning(false);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(MOTION_QUERY);
    /** 系统在播放中开启减少动态效果时立即停止，不自动补播。 */
    function respectMotionPreference() {
      if (query.matches) stopMotion();
    }
    query.addEventListener("change", respectMotionPreference);
    return () => query.removeEventListener("change", respectMotionPreference);
  }, [stopMotion]);

  useEffect(() => {
    if (!running) return;
    // 后台窗口可能不派发 animationend，兜底定时器防止播放锁永久占用。
    const timeout = window.setTimeout(stopMotion, BRAND_MOTION_MS + 120);
    return () => window.clearTimeout(timeout);
  }, [running, stopMotion]);

  /** 每次进入或聚焦只触发一次；系统偏好减少动态效果时保持静态强调。 */
  function playMotion() {
    if (playing.current || window.matchMedia(MOTION_QUERY).matches) return;
    playing.current = true;
    setRunning(true);
  }

  /** 仅主图标时间线结束时收尾，文字及光环的子动画不会提前结束整段播放。 */
  function finishMotion(event: AnimationEvent<HTMLImageElement>) {
    if (event.animationName === "brand-switch-pop") stopMotion();
  }

  /** 保留品牌返回模型库的行为，动画不阻塞点击或页面切换。 */
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onNavigate();
  }

  return (
    <a
      className="brand"
      href="#"
      aria-label="power-switch，返回模型库"
      data-motion={running ? "running" : "idle"}
      style={
        { "--brand-motion-duration": `${BRAND_MOTION_MS}ms` } as CSSProperties
      }
      onMouseEnter={playMotion}
      onFocus={playMotion}
      onClick={navigate}
    >
      <span className="brand-mark" aria-hidden="true">
        <img src="/icon.png" alt="" onAnimationEnd={finishMotion} />
        <span className="brand-sparks">
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="brand-name" aria-hidden="true">
        {Array.from("power-switch").map((letter, index) => (
          <span
            key={index}
            className={
              letter === "-" ? "brand-letter brand-dash" : "brand-letter"
            }
            style={{ "--letter-index": index } as CSSProperties}
          >
            {letter}
          </span>
        ))}
      </span>
    </a>
  );
}
