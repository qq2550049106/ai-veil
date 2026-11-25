// 横幅动画控制：只靠添加 / 移除 CSS 类驱动动画，不使用 requestAnimationFrame。
// 所有动画类与 @keyframes 统一定义在 overlay.css 中（border/styles.css 只放边框样式）。
// applyEnter 返回 Promise，动画结束或超时后一定会 resolve，调用方无需关心时序。

const IDLE_NAMES = ["blink", "wag", "float", "wiggle"];
const ENTER_NAMES = ["fade", "slide", "pop"];
const BLINK_ONCE_MS = 400;

/** 待机动画列表：允许字符串、数组，或逗号 / 空格 / 竖线分隔的字符串 */
function normalizeList(idleList) {
  if (Array.isArray(idleList)) {
    return idleList.map((item) => String(item == null ? "" : item).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof idleList === "string") {
    return idleList
      .split(/[,\s|]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * 应用待机动画：先清掉全部 idle-* 旧类，再按列表添加。
 * @param {HTMLElement} el
 * @param {string[]|string} idleList
 */
export function applyIdle(el, idleList) {
  if (!el || !el.classList) return;
  const names = normalizeList(idleList).filter((name) => IDLE_NAMES.indexOf(name) >= 0);
  for (const name of IDLE_NAMES) el.classList.remove(`idle-${name}`);
  for (const name of names) el.classList.add(`idle-${name}`);
  if (names.length > 0) el.setAttribute("data-idle", names.join(" "));
  else el.removeAttribute("data-idle");
}

/**
 * 播放入场动画，动画结束（或超时兜底）后移除类名。
 * @param {HTMLElement} el
 * @param {string} enterName  fade | slide | pop | none
 * @param {number} durationSec
 * @returns {Promise<void>}
 */
export function applyEnter(el, enterName, durationSec) {
  if (!el || !el.classList) return Promise.resolve();

  const name = String(enterName == null ? "" : enterName).trim().toLowerCase();
  for (const item of ENTER_NAMES) el.classList.remove(`enter-${item}`);

  if (ENTER_NAMES.indexOf(name) < 0) return Promise.resolve();

  const raw = Number(durationSec);
  const duration = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3) : 0.35;
  try {
    el.style.setProperty("--v-enter-dur", `${duration}s`);
  } catch (error) {
    // 自定义属性写失败不影响动画本身
  }

  const cls = `enter-${name}`;
  el.classList.add(cls);

  return new Promise((resolve) => {
    let finished = false;
    let timer = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      el.removeEventListener("animationend", onEnd);
      el.removeEventListener("animationcancel", onEnd);
      try {
        el.classList.remove(cls);
      } catch (error) {
        // 节点已移除时忽略
      }
      resolve();
    };

    const onEnd = (event) => {
      if (event && event.target && event.target !== el) return;
      finish();
    };

    el.addEventListener("animationend", onEnd);
    el.addEventListener("animationcancel", onEnd);
    // 超时兜底：系统禁用动画或元素不可见时 animationend 不会触发
    timer = setTimeout(finish, Math.round(duration * 1000) + 120);
  });
}

/**
 * 清空全部动画类与内联 animation，让元素回到无动画状态。
 * @param {HTMLElement} el
 */
export function clearAnimations(el) {
  if (!el || !el.classList) return;
  for (const name of IDLE_NAMES) el.classList.remove(`idle-${name}`);
  for (const name of ENTER_NAMES) el.classList.remove(`enter-${name}`);
  el.classList.remove("blink-once");
  try {
    el.style.animation = "";
  } catch (error) {
    // 忽略：部分宿主禁止写内联样式
  }
  el.removeAttribute("data-idle");
}

/**
 * 触发一次性眨眼：只给形状内部的 [data-part="eyes"] 加类，400ms 后移除。
 * 找不到节点时静默返回，绝不报错。
 * @param {HTMLElement} catRoot
 */
export function playBlinkOnce(catRoot) {
  if (!catRoot || typeof catRoot.querySelector !== "function") return;

  let eyes = null;
  try {
    eyes = catRoot.querySelector('[data-part="eyes"]');
  } catch (error) {
    eyes = null;
  }
  if (!eyes || !eyes.classList) return;

  try {
    eyes.classList.remove("blink-once");
    // 读一次布局属性强制重排，保证同一元素可以连续重复触发同一个动画
    void eyes.offsetWidth;
    eyes.classList.add("blink-once");
    setTimeout(() => {
      try {
        eyes.classList.remove("blink-once");
      } catch (error) {
        // 节点已移除时忽略
      }
    }, BLINK_ONCE_MS);
  } catch (error) {
    // 静默：眨眼只是装饰
  }
}
